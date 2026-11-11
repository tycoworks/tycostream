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
import {
  RootType,
  SelectionArgument,
  UpdateField,
  updateTypeName,
} from './schema.js';

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

// What a selection set of a type selects of its source
type SelectionSetReader = (
  info: GraphQLResolveInfo,
  source: SourceDefinition,
  type: GraphQLObjectType,
  fields: FieldNode[],
) => Selection;

/**
 * A list's resolver: a row's rows, or an update's updates, or [] when there
 * are none, as the tree leaves out an empty list
 */
type ListResolver<Parent> = (parent: Parent) => unknown[];

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
      selectionOf(source, args, info, selectionSetOf),
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
    // Its selection is what its updates select. Returns the service's
    // iterator itself, not a generator wrapping it, so a client that
    // disconnects closes its subscription at once.
    subscribe: (_parent, args, _context, info) =>
      apiService.subscribe(
        source,
        selectionOf(source, args, info, updateSelectionSetOf),
      ),
    resolve: (updates) => updates,
  };
}

/**
 * Every source's resolvers: its query and subscription, under the root
 * types' names, and its lists', under its type's and its update type's
 * names. A type, not an interface, so it fits the GraphQL module's resolver
 * map.
 */
export type Resolvers = {
  [RootType.Query]: Record<string, QueryResolver>;
  [RootType.Subscription]: Record<string, SubscriptionResolver>;
  // A type's lists. TypeScript makes this cover the root types too, hence
  // every kind.
  [typeName: string]: Record<
    string,
    | QueryResolver
    | SubscriptionResolver
    | ListResolver<Row>
    | ListResolver<GraphQLUpdate>
  >;
};

/**
 * Builds the resolvers for every source, a query and a subscription each,
 * delegating to ApiService, and one for each of its lists, in its type and
 * its update type
 */
export function buildResolvers(
  sources: Map<string, SourceDefinition>,
  apiService: ApiService,
): Resolvers {
  const queries: Record<string, QueryResolver> = {};
  const subscriptions: Record<string, SubscriptionResolver> = {};
  const lists: Record<
    string,
    Record<string, ListResolver<Row> | ListResolver<GraphQLUpdate>>
  > = {};

  sources.forEach((source, sourceName) => {
    queries[sourceName] = createQueryResolver(source, apiService);
    subscriptions[sourceName] = createSubscriptionResolver(source, apiService);
    if ([...(source.relationships?.values() ?? [])].some(({ many }) => many)) {
      lists[sourceName] = createListResolvers<Row>(source, (row) => row);
      lists[updateTypeName(sourceName)] = createListResolvers<GraphQLUpdate>(
        source,
        (update) => update.lists,
      );
    }
  });

  return {
    [RootType.Query]: queries,
    [RootType.Subscription]: subscriptions,
    ...lists,
  };
}

// A source's lists' resolvers, by field, each reading the list from where its
// parent, a row or an update, holds its lists
function createListResolvers<Parent>(
  source: SourceDefinition,
  listsOf: (parent: Parent) => Record<string, unknown> | undefined,
): Record<string, ListResolver<Parent>> {
  return Object.fromEntries(
    [...(source.relationships ?? [])]
      .filter(([, { many }]) => many)
      .map(([field]) => [
        field,
        (parent: Parent) =>
          (listsOf(parent)?.[field] as unknown[] | undefined) ?? [],
      ]),
  );
}

// The selection a root field makes of its source: its arguments, and what
// its selection set selects, read as a query's rows or a subscription's
// updates
function selectionOf(
  source: SourceDefinition,
  args: Args,
  info: GraphQLResolveInfo,
  selectionSetOf: SelectionSetReader,
): Selection {
  return {
    ...argumentsOf(args),
    ...selectionSetOf(info, source, objectType(info.returnType), [
      ...info.fieldNodes,
    ]),
  };
}

// What an update type's selection set selects of a source: data's columns
// and related rows, and each list beside data as a selection of its own,
// with its arguments, whose updates select in turn
function updateSelectionSetOf(
  info: GraphQLResolveInfo,
  source: SourceDefinition,
  type: GraphQLObjectType,
  fields: FieldNode[],
): Selection {
  const selected = byName(subfields(info, type, fields));
  const data = selected.get(UpdateField.Data) ?? [];
  const selection = selectionSetOf(
    info,
    source,
    objectType(type.getFields()[UpdateField.Data].type),
    data,
  );
  checkNoListsIn(source, selection);
  for (const [name, nodes] of selected) {
    const relationship = source.relationships?.get(name);
    if (relationship) {
      const field = type.getFields()[name];
      selection.relationships![name] = {
        ...argumentsOf(sameArguments(name, field, nodes, info)),
        ...updateSelectionSetOf(
          info,
          relationship.source,
          objectType(field.type),
          nodes,
        ),
      };
    }
  }
  return selection;
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
