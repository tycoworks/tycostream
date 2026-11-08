import { buildSchema } from 'graphql';
import type { GraphQLInputObjectType } from 'graphql';
import { generateSchema } from './schema.js';
import type {
  SourceDefinition,
  SourceConfiguration,
} from '../config/source.types.js';
import { DataType } from '../config/source.types.js';

describe('generateSchema', () => {
  // Helper to create a SourceConfiguration for tests
  const createConfig = (
    sources: Map<string, SourceDefinition> = new Map(),
  ): SourceConfiguration => ({
    sources,
    enums: new Map(),
  });

  it('should generate root types even with no sources', () => {
    const schema = generateSchema(createConfig());

    // Query and subscription root types, named as Hasura names them; there
    // are no mutations
    expect(schema).toContain('type query_root {');
    expect(schema).toContain('type subscription_root {');
    expect(schema).not.toContain('mutation');
  });

  it("should give each source a query of its rows and a subscription of its updates, both filtered by its bool_exp, under Hasura's root types", () => {
    const sources = new Map<string, SourceDefinition>([
      [
        'trades',
        {
          name: 'trades',
          primaryKeyField: 'id',
          fields: [{ name: 'id', dataType: DataType.Integer }],
        },
      ],
    ]);
    const schema = buildSchema(generateSchema(createConfig(sources)));

    expect(schema.getQueryType()!.name).toBe('query_root');
    expect(schema.getSubscriptionType()!.name).toBe('subscription_root');
    const query = schema.getQueryType()!.getFields().trades;
    expect(query.type.toString()).toBe('[trades!]!');
    expect(query.args.map((arg) => [arg.name, arg.type.toString()])).toEqual([
      ['where', 'trades_bool_exp'],
    ]);
    const subscription = schema.getSubscriptionType()!.getFields().trades;
    // One list of updates per timestamp
    expect(subscription.type.toString()).toBe('[trades_update!]!');
    expect(
      subscription.args.map((arg) => [arg.name, arg.type.toString()]),
    ).toEqual([['where', 'trades_bool_exp']]);
    expect(schema.getQueryType()!.getFields().ping).toBeUndefined();
  });

  it('should define the row_operation enum for subscription events', () => {
    const schema = generateSchema(createConfig());

    expect(schema).toContain('enum row_operation');
    expect(schema).toContain('INSERT');
    expect(schema).toContain('UPDATE');
    expect(schema).toContain('DELETE');
  });

  it('should define comparison input types for filtering', () => {
    const schema = generateSchema(createConfig());

    // String comparisons
    expect(schema).toContain('input String_comparison_exp');
    expect(schema).toContain('_eq: String');
    expect(schema).toContain('_neq: String');
    expect(schema).toContain('_in: [String!]');
    expect(schema).toContain('_is_null: Boolean');

    // Numeric comparisons
    expect(schema).toContain('input Int_comparison_exp');
    expect(schema).toContain('_gt: Int');
    expect(schema).toContain('_lt: Int');
    expect(schema).toContain('_gte: Int');
    expect(schema).toContain('_lte: Int');

    expect(schema).toContain('input Float_comparison_exp');
    expect(schema).toContain('input Boolean_comparison_exp');
  });

  it('should give each comparison input exactly the operators for its type', () => {
    const side = { name: 'side', values: ['buy', 'sell'] };
    // One view, since a schema with no subscription fields isn't valid
    const trades: SourceDefinition = {
      name: 'trades',
      primaryKeyField: 'id',
      fields: [
        { name: 'id', dataType: DataType.Integer },
        { name: 'side', dataType: DataType.String, enumType: side },
      ],
    };
    const config: SourceConfiguration = {
      sources: new Map([['trades', trades]]),
      enums: new Map([['side', side]]),
    };
    const schema = buildSchema(generateSchema(config));

    // Each input's operators, with the type each one takes
    const operators = (inputName: string) =>
      Object.fromEntries(
        Object.values(
          (schema.getType(inputName) as GraphQLInputObjectType).getFields(),
        ).map((field) => [field.name, field.type.toString()]),
      );
    const ordered = (type: string) => ({
      _eq: type,
      _neq: type,
      _gt: type,
      _gte: type,
      _lt: type,
      _lte: type,
      _in: `[${type}!]`,
      _nin: `[${type}!]`,
      _is_null: 'Boolean',
    });

    // Hasura's base set for every scalar and enum; text adds its patterns,
    // but not _similar or _nsimilar, which Materialize lacks
    expect(operators('String_comparison_exp')).toEqual({
      ...ordered('String'),
      _like: 'String',
      _nlike: 'String',
      _ilike: 'String',
      _nilike: 'String',
      _regex: 'String',
      _nregex: 'String',
      _iregex: 'String',
      _niregex: 'String',
    });
    expect(operators('Int_comparison_exp')).toEqual(ordered('Int'));
    expect(operators('Float_comparison_exp')).toEqual(ordered('Float'));
    expect(operators('Boolean_comparison_exp')).toEqual(ordered('Boolean'));
    expect(operators('side_comparison_exp')).toEqual(ordered('side'));
  });

  it('should generate expression input types for subscription filters', () => {
    const sources = new Map<string, SourceDefinition>([
      [
        'trades',
        {
          name: 'trades',
          primaryKeyField: 'id',
          fields: [
            { name: 'id', dataType: DataType.Integer },
            { name: 'symbol', dataType: DataType.String },
            { name: 'price', dataType: DataType.Float },
          ],
        },
      ],
    ]);

    const schema = generateSchema(createConfig(sources));

    // Should have a bool_exp input type with field comparisons
    expect(schema).toContain('input trades_bool_exp {');
    expect(schema).toContain('id: Int_comparison_exp');
    expect(schema).toContain('symbol: String_comparison_exp');
    expect(schema).toContain('price: Float_comparison_exp');

    // Should have logical operators
    expect(schema).toContain('_and: [trades_bool_exp!]');
    expect(schema).toContain('_or: [trades_bool_exp!]');
    expect(schema).toContain('_not: trades_bool_exp');
  });

  it('should generate source object types and update types', () => {
    const sources = new Map<string, SourceDefinition>([
      [
        'trades',
        {
          name: 'trades',
          primaryKeyField: 'id',
          fields: [
            { name: 'id', dataType: DataType.Integer },
            { name: 'symbol', dataType: DataType.String },
            { name: 'price', dataType: DataType.Float },
          ],
        },
      ],
    ]);

    const schema = generateSchema(createConfig(sources));

    // Check trades type
    expect(schema).toContain('type trades {');
    expect(schema).toContain('id: Int!'); // Primary key is non-nullable
    expect(schema).toContain('symbol: String');
    expect(schema).toContain('price: Float');

    // Check trades_update type
    expect(schema).toContain('type trades_update {');
    expect(schema).toContain('operation: row_operation!');
    expect(schema).toContain('data: trades');
    expect(schema).toContain('fields: [String!]');

    // Should have subscription field
    expect(schema).toContain(
      'trades(where: trades_bool_exp): [trades_update!]!',
    );
  });

  it('should handle DataType mappings correctly', () => {
    const sources = new Map<string, SourceDefinition>([
      [
        'test_types',
        {
          name: 'test_types',
          primaryKeyField: 'id',
          fields: [
            { name: 'id', dataType: DataType.BigInt },
            { name: 'active', dataType: DataType.Boolean },
            { name: 'count', dataType: DataType.Integer },
            { name: 'amount', dataType: DataType.Float },
            { name: 'created_at', dataType: DataType.Timestamp },
          ],
        },
      ],
    ]);

    const schema = generateSchema(createConfig(sources));

    expect(schema).toContain('id: String!'); // bigint -> String to preserve precision
    expect(schema).toContain('active: Boolean');
    expect(schema).toContain('count: Int');
    expect(schema).toContain('amount: Float');
    expect(schema).toContain('created_at: String');
  });

  it('should handle underscored source names', () => {
    const sources = new Map<string, SourceDefinition>([
      [
        'live_pnl',
        {
          name: 'live_pnl',
          primaryKeyField: 'account_id',
          fields: [
            { name: 'account_id', dataType: DataType.Integer },
            { name: 'pnl', dataType: DataType.Float },
          ],
        },
      ],
    ]);

    const schema = generateSchema(createConfig(sources));

    // Should use source name as-is
    expect(schema).toContain('type live_pnl {');
    expect(schema).toContain('type live_pnl_update {');
    expect(schema).toContain('data: live_pnl');
    expect(schema).toContain(
      'live_pnl(where: live_pnl_bool_exp): [live_pnl_update!]!',
    );
  });

  it('should treat JSON/JSONB fields as String', () => {
    const sourcesWithJson = new Map<string, SourceDefinition>([
      [
        'events',
        {
          name: 'events',
          primaryKeyField: 'id',
          fields: [
            { name: 'id', dataType: DataType.Integer },
            { name: 'data', dataType: DataType.JSON },
          ],
        },
      ],
    ]);

    const schema = generateSchema(createConfig(sourcesWithJson));
    expect(schema).not.toContain('scalar JSON');
    expect(schema).toContain('data: String'); // JSON is treated as String
  });

  it('should not throw error for all DataTypes', () => {
    const sources = new Map<string, SourceDefinition>([
      [
        'custom',
        {
          name: 'custom',
          primaryKeyField: 'id',
          fields: [
            { name: 'id', dataType: DataType.Integer },
            { name: 'custom_field', dataType: DataType.String },
          ],
        },
      ],
    ]);

    // Should not throw since all fields have valid DataTypes
    expect(() => generateSchema(createConfig(sources))).not.toThrow();
  });

  it('should generate GraphQL enum types from configuration', () => {
    const tradeSideEnum = {
      name: 'trade_side',
      values: ['buy', 'sell'],
    };
    const orderStatusEnum = {
      name: 'order_status',
      values: ['pending', 'filled', 'cancelled'],
    };

    const sources = new Map<string, SourceDefinition>([
      [
        'trades',
        {
          name: 'trades',
          primaryKeyField: 'id',
          fields: [
            { name: 'id', dataType: DataType.Integer },
            { name: 'symbol', dataType: DataType.String },
            {
              name: 'side',
              dataType: DataType.String,
              enumType: tradeSideEnum,
            },
            {
              name: 'status',
              dataType: DataType.String,
              enumType: orderStatusEnum,
            },
          ],
        },
      ],
    ]);

    const config: SourceConfiguration = {
      sources,
      enums: new Map([
        ['trade_side', tradeSideEnum],
        ['order_status', orderStatusEnum],
      ]),
    };

    const schema = generateSchema(config);

    // Should generate enum type definitions
    expect(schema).toContain('enum trade_side {');
    expect(schema).toContain('buy');
    expect(schema).toContain('sell');

    expect(schema).toContain('enum order_status {');
    expect(schema).toContain('pending');
    expect(schema).toContain('filled');
    expect(schema).toContain('cancelled');

    // Fields should use enum types
    expect(schema).toContain('side: trade_side');
    expect(schema).toContain('status: order_status');

    // Should generate enum comparison types
    expect(schema).toContain('input trade_side_comparison_exp {');
    expect(schema).toContain('_eq: trade_side');
    expect(schema).toContain('_gt: trade_side');
    expect(schema).toContain('input order_status_comparison_exp {');

    // Enum fields should use enum-specific comparison types for filtering
    expect(schema).toContain('side: trade_side_comparison_exp');
    expect(schema).toContain('status: order_status_comparison_exp');
  });

  it('should generate enum comparison types with ordinal operators', () => {
    const priorityEnum = {
      name: 'priority_level',
      values: ['low', 'medium', 'high', 'critical'],
    };

    const sources = new Map<string, SourceDefinition>([
      [
        'tasks',
        {
          name: 'tasks',
          primaryKeyField: 'id',
          fields: [
            { name: 'id', dataType: DataType.Integer },
            {
              name: 'priority',
              dataType: DataType.String,
              enumType: priorityEnum,
            },
          ],
        },
      ],
    ]);

    const config: SourceConfiguration = {
      sources,
      enums: new Map([['priority_level', priorityEnum]]),
    };

    const schema = generateSchema(config);

    // Should generate enum comparison type with all operators
    expect(schema).toContain('input priority_level_comparison_exp {');
    expect(schema).toContain('_eq: priority_level');
    expect(schema).toContain('_neq: priority_level');
    expect(schema).toContain('_gt: priority_level'); // Ordinal comparison
    expect(schema).toContain('_gte: priority_level'); // Ordinal comparison
    expect(schema).toContain('_lt: priority_level'); // Ordinal comparison
    expect(schema).toContain('_lte: priority_level'); // Ordinal comparison
    expect(schema).toContain('_in: [priority_level!]');
    expect(schema).toContain('_nin: [priority_level!]');
    expect(schema).toContain('_is_null: Boolean');
  });

  it('should handle shared enum definitions across sources', () => {
    const enumDef = {
      name: 'shared_status',
      values: ['active', 'inactive'],
    };

    const sources = new Map<string, SourceDefinition>([
      [
        'source1',
        {
          name: 'source1',
          primaryKeyField: 'id',
          fields: [
            { name: 'id', dataType: DataType.Integer },
            { name: 'status', dataType: DataType.String, enumType: enumDef },
          ],
        },
      ],
      [
        'source2',
        {
          name: 'source2',
          primaryKeyField: 'id',
          fields: [
            { name: 'id', dataType: DataType.Integer },
            { name: 'state', dataType: DataType.String, enumType: enumDef },
          ],
        },
      ],
    ]);

    const config: SourceConfiguration = {
      sources,
      enums: new Map([['shared_status', enumDef]]),
    };

    const schema = generateSchema(config);

    // Should only define the enum once
    const enumMatches = schema.match(/enum shared_status \{/g);
    expect(enumMatches).toHaveLength(1);

    // Both sources should reference the same enum
    expect(schema).toContain('status: shared_status');
    expect(schema).toContain('state: shared_status');
  });
});
