import { buildSchema } from 'graphql';
import { PostgresType } from '../common/types.js';
import type {
  GraphQLEnumType,
  GraphQLInputObjectType,
  GraphQLObjectType,
} from 'graphql';
import { generateSchema } from './schema.js';
import type {
  SourceDefinition,
  SourceField,
  SourceConfiguration,
} from '../config/source.types.js';

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

    // Query and subscription root types, named query_root and subscription_root; there
    // are no mutations
    expect(schema).toContain('type query_root {');
    expect(schema).toContain('type subscription_root {');
    expect(schema).not.toContain('mutation');
  });

  it('should give each source a query of its rows and a subscription of its updates, both filtered by its bool_exp, under query_root and subscription_root', () => {
    const sources = new Map<string, SourceDefinition>([
      [
        'trades',
        {
          name: 'trades',
          primaryKeyField: 'id',
          fields: [{ name: 'id', type: PostgresType.Int4 }],
        },
      ],
    ]);
    const schema = buildSchema(generateSchema(createConfig(sources)));

    expect(schema.getQueryType()!.name).toBe('query_root');
    expect(schema.getSubscriptionType()!.name).toBe('subscription_root');
    const query = schema.getQueryType()!.getFields().trades;
    expect(query.type.toString()).toBe('[trades!]!');
    // Each takes a selection: a filter, an order, a limit and an offset
    const selectionArgs = [
      ['where', 'trades_bool_exp'],
      ['order_by', '[trades_order_by!]'],
      ['limit', 'Int'],
      ['offset', 'Int'],
    ];
    expect(query.args.map((arg) => [arg.name, arg.type.toString()])).toEqual(
      selectionArgs,
    );
    const subscription = schema.getSubscriptionType()!.getFields().trades;
    // One list of updates per timestamp
    expect(subscription.type.toString()).toBe('[trades_update!]!');
    expect(
      subscription.args.map((arg) => [arg.name, arg.type.toString()]),
    ).toEqual(selectionArgs);
    expect(schema.getQueryType()!.getFields().ping).toBeUndefined();
  });

  it('should give each source an order_by input: each column, and the way it sorts', () => {
    const sources = new Map<string, SourceDefinition>([
      [
        'trades',
        {
          name: 'trades',
          primaryKeyField: 'id',
          fields: [
            { name: 'id', type: PostgresType.Int4 },
            { name: 'price', type: PostgresType.Numeric },
          ],
        },
      ],
    ]);
    const schema = buildSchema(generateSchema(createConfig(sources)));

    expect(
      Object.values(
        (
          schema.getType('trades_order_by') as GraphQLInputObjectType
        ).getFields(),
      ).map((field) => [field.name, field.type.toString()]),
    ).toEqual([
      ['id', 'order_by'],
      ['price', 'order_by'],
    ]);
    expect(
      (schema.getType('order_by') as GraphQLEnumType)
        .getValues()
        .map((value) => value.name),
    ).toEqual([
      'asc',
      'asc_nulls_first',
      'asc_nulls_last',
      'desc',
      'desc_nulls_first',
      'desc_nulls_last',
    ]);
  });

  it('should define the row_operation enum for subscription events', () => {
    const schema = generateSchema(createConfig());

    expect(schema).toContain('enum row_operation');
    expect(schema).toContain('INSERT');
    expect(schema).toContain('UPDATE');
    expect(schema).toContain('DELETE');
  });

  it('should declare and compare only the scalars the columns use', () => {
    const sources = new Map<string, SourceDefinition>([
      [
        'trades',
        {
          name: 'trades',
          primaryKeyField: 'id',
          fields: [
            { name: 'id', type: PostgresType.Int4 },
            { name: 'symbol', type: PostgresType.Text },
            { name: 'big', type: PostgresType.Int8 },
          ],
        },
      ],
    ]);
    const schema = generateSchema(createConfig(sources));

    // GraphQL's own scalars need no declaring; custom ones do
    expect(schema).toContain('scalar bigint');
    expect(schema).not.toContain('scalar Int');
    expect(schema).not.toContain('scalar String');
    expect(schema).toContain('input Int_comparison_exp');
    expect(schema).toContain('input String_comparison_exp');
    expect(schema).toContain('input bigint_comparison_exp');
    expect(schema).not.toContain('Float_comparison_exp');
    expect(schema).not.toContain('Boolean_comparison_exp');
  });

  it('should give each comparison input exactly the operators for its type', () => {
    const side = { name: 'side', values: ['buy', 'sell'] };
    // One view, since a schema with no subscription fields isn't valid
    const trades: SourceDefinition = {
      name: 'trades',
      primaryKeyField: 'id',
      fields: [
        { name: 'id', type: PostgresType.Int4 },
        { name: 'side', type: PostgresType.Text, enumType: side },
        { name: 'symbol', type: PostgresType.Text },
        { name: 'price', type: PostgresType.Float4 },
        { name: 'live', type: PostgresType.Bool },
        { name: 'big', type: PostgresType.Int8 },
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

    // The base set for every scalar and enum; text adds its patterns,
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
    expect(operators('bigint_comparison_exp')).toEqual(ordered('bigint'));
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
            { name: 'id', type: PostgresType.Int4 },
            { name: 'symbol', type: PostgresType.Text },
            { name: 'price', type: PostgresType.Float4 },
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
            { name: 'id', type: PostgresType.Int4 },
            { name: 'symbol', type: PostgresType.Text },
            { name: 'price', type: PostgresType.Float4 },
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
      'trades(where: trades_bool_exp, order_by: [trades_order_by!], limit: Int, offset: Int): [trades_update!]!',
    );
  });

  it("should give each Postgres type its GraphQL scalar: GraphQL's own where one fits, and one named after the type for the rest", () => {
    const scalars: [Pick<SourceField, 'type'>, string][] = [
      [{ type: PostgresType.Int2 }, 'smallint'],
      [{ type: PostgresType.Int4 }, 'Int'],
      [{ type: PostgresType.Int8 }, 'bigint'],
      [{ type: PostgresType.Float4 }, 'Float'],
      [{ type: PostgresType.Float8 }, 'float8'],
      [{ type: PostgresType.Numeric }, 'numeric'],
      [{ type: PostgresType.Text }, 'String'],
      [{ type: PostgresType.Varchar }, 'String'],
      [{ type: PostgresType.Bpchar }, 'bpchar'],
      [{ type: PostgresType.Bool }, 'Boolean'],
      [{ type: PostgresType.Uuid }, 'uuid'],
      [{ type: PostgresType.Timestamp }, 'timestamp'],
      [{ type: PostgresType.Timestamptz }, 'timestamptz'],
      [{ type: PostgresType.Date }, 'date'],
      [{ type: PostgresType.Time }, 'time'],
      [{ type: PostgresType.Interval }, 'interval'],
      [{ type: PostgresType.Json }, 'json'],
      [{ type: PostgresType.Jsonb }, 'jsonb'],
      [{ type: PostgresType.Bytea }, 'bytea'],
    ];
    const sources = new Map<string, SourceDefinition>([
      [
        'every_type',
        {
          name: 'every_type',
          primaryKeyField: 'c0',
          fields: scalars.map(([type], i) => ({ name: `c${i}`, ...type })),
        },
      ],
    ]);
    const schema = buildSchema(generateSchema(createConfig(sources)));
    const fields = (
      schema.getType('every_type') as GraphQLObjectType
    ).getFields();

    expect(
      scalars.map((_, i) => fields[`c${i}`].type.toString().replace('!', '')),
    ).toEqual(scalars.map(([, scalar]) => scalar));
  });

  it('should give text, varchar and bpchar the text patterns', () => {
    const sources = new Map<string, SourceDefinition>([
      [
        'texts',
        {
          name: 'texts',
          primaryKeyField: 'id',
          fields: [
            { name: 'id', type: PostgresType.Int4 },
            { name: 'code', type: PostgresType.Bpchar },
            { name: 'name', type: PostgresType.Varchar },
          ],
        },
      ],
    ]);
    const schema = buildSchema(generateSchema(createConfig(sources)));
    const operators = (inputName: string) =>
      Object.keys(
        (schema.getType(inputName) as GraphQLInputObjectType).getFields(),
      );

    expect(operators('bpchar_comparison_exp')).toContain('_ilike');
    expect(operators('String_comparison_exp')).toContain('_ilike');
    expect(operators('Int_comparison_exp')).not.toContain('_ilike');
  });

  describe('foreign keys', () => {
    const positions: SourceDefinition = {
      name: 'positions',
      primaryKeyField: 'instrument_id',
      fields: [
        { name: 'instrument_id', type: PostgresType.Int4 },
        { name: 'net_position', type: PostgresType.Int8 },
      ],
    };
    const trades = (fields: SourceDefinition['fields']): SourceDefinition => ({
      name: 'trades',
      primaryKeyField: 'id',
      fields,
      foreignKeys: [{ column: 'instrument_id', references: positions }],
    });

    it('should give a row a field of the row each foreign key references, named after its source, null when none matches', () => {
      const schema = buildSchema(
        generateSchema(
          createConfig(
            new Map([
              ['positions', positions],
              [
                'trades',
                trades([
                  { name: 'id', type: PostgresType.Int4 },
                  { name: 'instrument_id', type: PostgresType.Int4 },
                ]),
              ],
            ]),
          ),
        ),
      );

      const field = (schema.getType('trades') as GraphQLObjectType).getFields()
        .positions;
      expect(String(field.type)).toBe('positions');
    });

    it('should leave it to GraphQL to refuse a foreign key whose field clashes with a column', () => {
      const sdl = generateSchema(
        createConfig(
          new Map([
            ['positions', positions],
            [
              'trades',
              trades([
                { name: 'id', type: PostgresType.Int4 },
                { name: 'instrument_id', type: PostgresType.Int4 },
                { name: 'positions', type: PostgresType.Text },
              ]),
            ],
          ]),
        ),
      );

      expect(() => buildSchema(sdl)).toThrow(
        'Field "trades.positions" can only be defined once.',
      );
    });
  });

  it('should handle underscored source names', () => {
    const sources = new Map<string, SourceDefinition>([
      [
        'live_pnl',
        {
          name: 'live_pnl',
          primaryKeyField: 'account_id',
          fields: [
            { name: 'account_id', type: PostgresType.Int4 },
            { name: 'pnl', type: PostgresType.Float4 },
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
      'live_pnl(where: live_pnl_bool_exp, order_by: [live_pnl_order_by!], limit: Int, offset: Int): [live_pnl_update!]!',
    );
  });

  it('should serve jsonb as a jsonb scalar', () => {
    const sourcesWithJson = new Map<string, SourceDefinition>([
      [
        'events',
        {
          name: 'events',
          primaryKeyField: 'id',
          fields: [
            { name: 'id', type: PostgresType.Int4 },
            { name: 'data', type: PostgresType.Jsonb },
          ],
        },
      ],
    ]);

    const schema = generateSchema(createConfig(sourcesWithJson));
    expect(schema).toContain('scalar jsonb');
    expect(schema).toContain('data: jsonb');
    expect(schema).toContain('data: jsonb_comparison_exp');
  });

  it('should not throw error for valid types', () => {
    const sources = new Map<string, SourceDefinition>([
      [
        'custom',
        {
          name: 'custom',
          primaryKeyField: 'id',
          fields: [
            { name: 'id', type: PostgresType.Int4 },
            { name: 'custom_field', type: PostgresType.Text },
          ],
        },
      ],
    ]);

    // Should not throw since all fields have valid types
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
            { name: 'id', type: PostgresType.Int4 },
            { name: 'symbol', type: PostgresType.Text },
            {
              name: 'side',
              type: PostgresType.Text,
              enumType: tradeSideEnum,
            },
            {
              name: 'status',
              type: PostgresType.Text,
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
            { name: 'id', type: PostgresType.Int4 },
            {
              name: 'priority',
              type: PostgresType.Text,
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
            { name: 'id', type: PostgresType.Int4 },
            { name: 'status', type: PostgresType.Text, enumType: enumDef },
          ],
        },
      ],
      [
        'source2',
        {
          name: 'source2',
          primaryKeyField: 'id',
          fields: [
            { name: 'id', type: PostgresType.Int4 },
            { name: 'state', type: PostgresType.Text, enumType: enumDef },
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
