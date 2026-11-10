import { collectSubFields } from '@graphql-tools/utils';
import {
  TypeNameMetaFieldDef,
  assertObjectType,
  getNamedType,
  isObjectType,
} from 'graphql';
import type {
  FieldNode,
  GraphQLObjectType,
  GraphQLOutputType,
  GraphQLResolveInfo,
} from 'graphql';
import type { SourceDefinition } from '../config/source.types.js';
import type { OrderBy, Row, Selection, WhereClause } from '../common/types.js';
import { ApiService, GraphQLUpdate } from './api.service.js';
import { RootFieldArgument, RootType, UpdateField } from './schema.js';

// Every resolver takes a selection of a source's rows
type Args = {
  [RootFieldArgument.Where]?: WhereClause;
  [RootFieldArgument.OrderBy]?: OrderBy;
  [RootFieldArgument.Limit]?: number;
  [RootFieldArgument.Offset]?: number;
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
 * Creates a query resolver for a specific source
 * Acts as a thin pass-through to ApiService
 */
function createQueryResolver(
  source: SourceDefinition,
  apiService: ApiService,
): QueryResolver {
  // A client that leaves mid-query ends it in the database
  return (_parent, args, context, info) =>
    apiService.query(source, selectionOf(args, info), context.request?.signal);
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
    subscribe: (_parent, args, _context, info) =>
      apiService.subscribe(source, selectionOf(args, info, UpdateField.Data)),
    resolve: (updates) => updates,
  };
}

/**
 * Every source's resolvers, under the root types' names. A type, not an
 * interface, so it fits the GraphQL module's resolver map.
 */
export type Resolvers = {
  [RootType.Query]: Record<string, QueryResolver>;
  [RootType.Subscription]: Record<string, SubscriptionResolver>;
};

/**
 * Builds the resolvers for every source, a query and a subscription each,
 * delegating to ApiService
 */
export function buildResolvers(
  sources: Map<string, SourceDefinition>,
  apiService: ApiService,
): Resolvers {
  const queries: Record<string, QueryResolver> = {};
  const subscriptions: Record<string, SubscriptionResolver> = {};

  sources.forEach((source, sourceName) => {
    queries[sourceName] = createQueryResolver(source, apiService);
    subscriptions[sourceName] = createSubscriptionResolver(source, apiService);
  });

  return {
    [RootType.Query]: queries,
    [RootType.Subscription]: subscriptions,
  };
}

// The selection a root field makes: what it selects of its rows, or of those
// within one of its fields, and its arguments
function selectionOf(
  args: Args,
  info: GraphQLResolveInfo,
  within?: string,
): Selection {
  return {
    ...selectedRow(info, within),
    where: args[RootFieldArgument.Where],
    orderBy: args[RootFieldArgument.OrderBy],
    limit: args[RootFieldArgument.Limit],
    offset: args[RootFieldArgument.Offset],
  };
}

// What a root field selects of its rows, or of those within one of its fields
function selectedRow(info: GraphQLResolveInfo, within?: string): Selection {
  let type = objectType(info.returnType);
  let fields: FieldNode[] = [...info.fieldNodes];
  if (within) {
    fields = subfields(info, type, fields).filter(
      (field) => field.name.value === within,
    );
    type = objectType(type.getFields()[within].type);
  }
  return rowSelection(info, type, fields);
}

// What the fields select of a row of the type: its columns, and each joined
// row's selection, by its field. GraphQL's field collection follows fragments
// and applies @skip and @include; aliases make no difference, and __typename
// isn't a column.
function rowSelection(
  info: GraphQLResolveInfo,
  type: GraphQLObjectType,
  fields: FieldNode[],
): Selection {
  const columns = new Set<string>();
  const joins = new Map<string, FieldNode[]>();
  for (const field of subfields(info, type, fields)) {
    const name = field.name.value;
    if (name === TypeNameMetaFieldDef.name) {
      continue;
    }
    if (isObjectType(getNamedType(type.getFields()[name].type))) {
      joins.set(name, [...(joins.get(name) ?? []), field]);
    } else {
      columns.add(name);
    }
  }
  return {
    columns: [...columns],
    joins: Object.fromEntries(
      [...joins].map(([name, nodes]) => [
        name,
        rowSelection(info, objectType(type.getFields()[name].type), nodes),
      ]),
    ),
  };
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
