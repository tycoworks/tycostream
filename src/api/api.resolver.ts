import { collectSubFields } from '@graphql-tools/utils';
import {
  TypeNameMetaFieldDef,
  assertObjectType,
  getArgumentValues,
  getNamedType,
} from 'graphql';
import type {
  FieldNode,
  GraphQLField,
  GraphQLObjectType,
  GraphQLOutputType,
  GraphQLResolveInfo,
} from 'graphql';
import type { SourceDefinition } from '../config/source.types.js';
import type { OrderBy, Row, Selection, WhereClause } from '../common/types.js';
import { ApiService } from './api.service.js';
import type { GraphQLUpdate } from './tree.js';
import { RootType, SelectionArgument, UpdateField } from './schema.js';

// A selection of a source's rows takes these arguments: a root field's, and
// a relationship to many rows'
type Args = {
  [SelectionArgument.Where]?: WhereClause;
  [SelectionArgument.OrderBy]?: OrderBy;
  [SelectionArgument.Limit]?: number;
  [SelectionArgument.Offset]?: number;
};

/**
 * The GraphQL context Yoga gives each request. Its request's signal aborts
 * when the client's connection closes before the response has finished.
 */
type Context = { request?: { signal: AbortSignal } };

/**
 * GraphQL query resolver type: a source's current rows, once
 */
type QueryResolver = (
  parent: unknown,
  args: Args,
  context: Context,
  info: GraphQLResolveInfo,
) => Promise<Row[]>;

/**
 * GraphQL subscription resolver type
 * subscribe returns each timestamp's updates; resolve gives each list as the
 * field's value
 */
type SubscriptionResolver = {
  subscribe: (
    parent: unknown,
    args: Args,
    context: Context,
    info: GraphQLResolveInfo,
  ) => AsyncIterableIterator<GraphQLUpdate[]>;
  resolve: (updates: GraphQLUpdate[]) => GraphQLUpdate[];
};

/**
 * A list's resolver: its rows, or [] when there are none, as a query's tree
 * leaves out a list with no rows
 */
type ListResolver = (row: Row) => Row[];

/**
 * Creates a query resolver for a specific source
 * Acts as a thin pass-through to ApiService
 */
function createQueryResolver(
  source: SourceDefinition,
  apiService: ApiService,
): QueryResolver {
  // A client that leaves mid-query ends it in the database
  return (_parent, args, context, info) =>
    apiService.query(
      source,
      selectionOf(source, args, info),
      context.request?.signal,
    );
}

/**
 * Creates a subscription resolver for a specific source
 * Acts as a thin pass-through to ApiService
 */
function createSubscriptionResolver(
  source: SourceDefinition,
  apiService: ApiService,
): SubscriptionResolver {
  return {
    // Its columns are those its updates' data selects. Returns the service's
    // iterator itself, not a generator wrapping it, so a client that
    // disconnects closes its subscription at once.
    subscribe: (_parent, args, _context, info) => {
      const selection = selectionOf(source, args, info, UpdateField.Data);
      checkNoListsIn(source, selection);
      return apiService.subscribe(source, selection);
    },
    resolve: (updates) => updates,
  };
}

/**
 * Every source's resolvers: its query and subscription, under the root
 * types' names, and its lists', under its type's name. A type, not an
 * interface, so it fits the GraphQL module's resolver map.
 */
export type Resolvers = {
  [RootType.Query]: Record<string, QueryResolver>;
  [RootType.Subscription]: Record<string, SubscriptionResolver>;
  // A source type's lists. TypeScript makes this cover the root types too,
  // hence all three.
  [sourceName: string]: Record<
    string,
    QueryResolver | SubscriptionResolver | ListResolver
  >;
};

/**
 * Builds the resolvers for every source, a query and a subscription each,
 * delegating to ApiService, and one for each of its relationships to many
 * rows
 */
export function buildResolvers(
  sources: Map<string, SourceDefinition>,
  apiService: ApiService,
): Resolvers {
  const queries: Record<string, QueryResolver> = {};
  const subscriptions: Record<string, SubscriptionResolver> = {};
  const lists: Record<string, Record<string, ListResolver>> = {};

  sources.forEach((source, sourceName) => {
    queries[sourceName] = createQueryResolver(source, apiService);
    subscriptions[sourceName] = createSubscriptionResolver(source, apiService);
    const resolvers = createListResolvers(source);
    if (Object.keys(resolvers).length > 0) {
      lists[sourceName] = resolvers;
    }
  });

  return {
    [RootType.Query]: queries,
    [RootType.Subscription]: subscriptions,
    ...lists,
  };
}

// A source's lists' resolvers, by field
function createListResolvers(
  source: SourceDefinition,
): Record<string, ListResolver> {
  return Object.fromEntries(
    [...(source.relationships ?? [])]
      .filter(([, { many }]) => many)
      .map(([field]) => [
        field,
        (row: Row) => (row[field] as Row[] | undefined) ?? [],
      ]),
  );
}

// The selection a root field makes of its source: its arguments, and what it
// selects, or what one of its fields selects
function selectionOf(
  source: SourceDefinition,
  args: Args,
  info: GraphQLResolveInfo,
  within?: string,
): Selection {
  let type = objectType(info.returnType);
  let fields: FieldNode[] = [...info.fieldNodes];
  if (within) {
    fields = subfields(info, type, fields).filter(
      (field) => field.name.value === within,
    );
    type = objectType(type.getFields()[within].type);
  }
  return {
    ...argumentsOf(args),
    ...selectionSetOf(info, source, type, fields),
  };
}

// A subscription's lists go beside data, so none is selected within data,
// or within a related row in it, named by its field
function checkNoListsIn(
  source: SourceDefinition,
  selection: Selection,
  within?: string,
): void {
  for (const [field, selected] of Object.entries(
    selection.relationships ?? {},
  )) {
    const { many, source: related } = source.relationships!.get(field)!;
    if (many) {
      throw new Error(
        within === undefined
          ? `Subscriptions select '${field}' beside '${UpdateField.Data}', not inside it`
          : `Subscriptions can't select '${field}' inside '${within}'`,
      );
    }
    checkNoListsIn(related, selected, field);
  }
}

// A selection's arguments
function argumentsOf(args: Args): Selection {
  return {
    where: args[SelectionArgument.Where],
    orderBy: args[SelectionArgument.OrderBy],
    limit: args[SelectionArgument.Limit],
    offset: args[SelectionArgument.Offset],
  };
}

// What a selection set of a source's type selects: its columns, and each
// relationship as a selection of its own, with its arguments. GraphQL's field collection
// follows fragments and applies @skip and @include. Each field is selected
// once, whatever its aliases, which GraphQL answers from the same row, so a
// relationship's aliases must have the same arguments. __typename isn't a
// column.
function selectionSetOf(
  info: GraphQLResolveInfo,
  source: SourceDefinition,
  type: GraphQLObjectType,
  fields: FieldNode[],
): Selection {
  const columns: string[] = [];
  const relationships: Record<string, Selection> = {};
  for (const [name, nodes] of byName(subfields(info, type, fields))) {
    const relationship = source.relationships?.get(name);
    if (!relationship) {
      columns.push(name);
      continue;
    }
    const field = type.getFields()[name];
    relationships[name] = {
      ...argumentsOf(sameArguments(name, field, nodes, info)),
      ...selectionSetOf(
        info,
        relationship.source,
        objectType(field.type),
        nodes,
      ),
    };
  }
  return { columns, relationships };
}

// Fields by name, in the order they're first selected, without __typename
function byName(fields: FieldNode[]): Map<string, FieldNode[]> {
  const named = new Map<string, FieldNode[]>();
  for (const field of fields) {
    const name = field.name.value;
    if (name !== TypeNameMetaFieldDef.name) {
      named.set(name, [...(named.get(name) ?? []), field]);
    }
  }
  return named;
}

// The arguments a relationship is selected with, each time the same
function sameArguments(
  name: string,
  field: GraphQLField<unknown, unknown>,
  nodes: FieldNode[],
  info: GraphQLResolveInfo,
): Args {
  const [first, ...others] = nodes.map((node) =>
    getArgumentValues(field, node, info.variableValues),
  );
  if (others.some((args) => JSON.stringify(args) !== JSON.stringify(first))) {
    throw new Error(
      `'${name}' is selected twice with different arguments; select it once`,
    );
  }
  return first;
}

// The fields selected directly under the given ones, which are of the type
function subfields(
  info: GraphQLResolveInfo,
  type: GraphQLObjectType,
  fields: FieldNode[],
): FieldNode[] {
  const { fields: byResponseKey } = collectSubFields(
    info.schema,
    info.fragments,
    info.variableValues,
    type,
    fields,
  );
  return [...byResponseKey.values()].flat();
}

// The object type a field returns, inside any lists and non-nulls
function objectType(type: GraphQLOutputType): GraphQLObjectType {
  return assertObjectType(getNamedType(type));
}
