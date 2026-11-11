# Plan: a Hasura-compatible API

Status: draft, 8 Nov 2026; not yet agreed. Branch: `hasura-compatibility`. Breaks clients, so it's released as `v0.4.0`. Follows one message per timestamp ([#18](https://github.com/tycoworks/tycostream/pull/18)); comes before relationships ([#2](https://github.com/tycoworks/tycostream/issues/2)).

## Summary

tycostream's generated GraphQL API follows Hasura v2's conventions, best effort (Chris, 8 Nov): the same type names, scalars, operators and root fields, so a query written for Hasura works against tycostream unchanged, as far as tycostream's features go. Subscriptions deliberately differ: they send what changed.

## Why Hasura v2

- **The closest thing to a standard** for GraphQL over Postgres; tycostream's filters already follow it.
- **v2, not v3.** Hasura v3 (DDN) lets each project shape its own schema, so v2's conventions are what "Hasura-compatible" means.
- **Hasura for the schema, The Guild for the transport.** The Guild has no product that generates an API from a database, so it has no schema conventions to follow. tycostream already uses its GraphQL Yoga and GraphQL over SSE, and a live query would use its `@live` (below).
- **Best effort.** No conformance test against a running Hasura (Chris, 8 Nov). The conventions come from Hasura v2's source, which defines them in a few places: type and root names in [`Name.hs`](https://github.com/hasura/graphql-engine/blob/master/server/src-lib/Hasura/Name.hs) and [`SourceCustomization.hs`](https://github.com/hasura/graphql-engine/blob/master/server/src-lib/Hasura/RQL/Types/SourceCustomization.hs), operators in [`Schema.hs`](https://github.com/hasura/graphql-engine/blob/master/server/src-lib/Hasura/Backends/Postgres/Instances/Schema.hs), and scalars in [`Types.hs`](https://github.com/hasura/graphql-engine/blob/master/server/src-lib/Hasura/Backends/Postgres/SQL/Types.hs). Where its docs and its code disagree, the code wins.

## What we reuse

Checked on 8 Nov: nothing of Hasura's can be plugged in.

- **Hasura itself won't run on Materialize.** Both v2 and v3's Postgres connector build results with `json_agg` and `row_to_json`, which Materialize doesn't document (inferred, not tested); a request for Materialize support has been open on v2 since 2020. So queries can't simply be left to Hasura.
- **The engines are Haskell (v2) and Rust (v3)**, with no libraries published for reuse; v3 has no fixed conventions at all, only what each project's metadata says. No maintained TypeScript library generates Hasura's schema or compiles its filters.
- **What we take:** the conventions, from v2's source as above; and, for test cases, v2's own golden tests of filters ([`tests-py`](https://github.com/hasura/graphql-engine/tree/master/server/tests-py/queries/graphql_query/boolexp), Apache-2.0).

## Where tycostream follows Hasura

### Names

| | Today | Hasura v2 |
|---|---|---|
| A source's filter | `tradesExpression` | `trades_bool_exp` |
| A scalar's comparisons | `IntComparison`, `StringComparison` | `Int_comparison_exp`, `String_comparison_exp` |
| An enum's comparisons | `sideComparison` | `side_comparison_exp` |
| Root types | `Query`, `Subscription` | `query_root`, `subscription_root` |

tycostream's own types take the same style: `row_operation` for `RowOperation`, `trades_update` for `tradesUpdate`.

### Scalars

Hasura names each column's GraphQL type after its Postgres type. `schema.yaml`'s types were tycostream's own (`Integer`, `Float`, `BigInt`…), and several collapsed: `numeric` became `Float`, losing precision, and timestamps, `uuid` and `bigint` became `String` or `ID`.

Instead, tycostream uses Postgres's types throughout (Chris, 9 Nov), and turns them into GraphQL only at the API:

- **A column's type is its Postgres type.** One list, `PostgresType` in `common/types.ts`, names the types tycostream serves, with the type IDs pg-types gives them (`PostgresType.Int4` is `builtins.INT4`), the IDs every Postgres-compatible database reports. It's the only file that imports pg-types, and tycostream's own `DataType` is gone.
- **`schema.yaml` names a type as Postgres's catalog does** (`pg_type.typname`): `int4`, `numeric`, `timestamptz`. The generator writes them, so nobody needs to by hand (Chris, 9 Nov). An enum column takes its enum's name, as a user-defined type would.
- **The generator reads `pg_catalog`,** which Postgres, Materialize and RisingWave all have, instead of Materialize's `SHOW COLUMNS`.
- **The API is the one place that turns a type into GraphQL:** one complete table from `PostgresType` to its GraphQL type, the custom names in an enum. It follows Hasura's own code (`mkScalarTypeName` and `pgScalarTypeToText` in Hasura's `Types.hs`): GraphQL's own scalars where a type fits, and Hasura's name for the rest. The code itself doesn't name Hasura (Chris, 9 Nov).
- **The database layer needs no types** once it parses by the database's own (step 3b).

| `schema.yaml` | GraphQL | Before |
|---|---|---|
| `int2` | `smallint` | `Int` |
| `int4` | `Int` | `Int` |
| `int8` | `bigint` | `String` |
| `float4` | `Float` | `Float` |
| `float8` | `float8` | `Float` |
| `numeric` | `numeric` | `Float` |
| `text`, `varchar` | `String` | `String` |
| `bpchar` | `bpchar` | `String` |
| `bool` | `Boolean` | `Boolean` |
| `uuid` | `uuid` | `ID` |
| `timestamp`, `timestamptz`, `date`, `time`, `interval` | the same names | `String` |
| `json`, `jsonb`, `bytea` | the same names | `String` |
| arrays | not served for now | `String` |

- **`int8` and `numeric` are sent as JSON numbers,** as Hasura sends them by default (Chris, 9 Nov), so a client needs to know nothing about them. tycostream parses them into numbers as it reads them, with its other conversions (`postgres.ts`); a number keeps about 15 significant digits, so a larger value loses its last ones. Hasura's option to send them as strings (`HASURA_GRAPHQL_STRINGIFY_NUMERIC_TYPES`) isn't offered. As inputs, these scalars take a number or a string; a client sends an `int8` beyond 2^53 as a string.
- **`NaN` and `Infinity`** can't travel as GraphQL's `Float`, which raises a field error for them, and a `float8` sends them as `null`. A known limit: Postgres only gives them when asked to.
- **Arrays aren't served for now.** They were sent as text (`{1,2}`), which was half a feature; they come back as GraphQL lists, on the roadmap, which parsing by the database's own types makes cheap.
- **Timestamps as Hasura sends them,** in ISO 8601 (`2026-11-08T10:00:00+00:00`), not the text form, which has a space; and `json` and `jsonb` as JSON values (step 3b).

#### Parsing by the database's own types (step 3b)

Every result tells node-postgres each column's real type, and node-postgres turns each value's text into a JavaScript value by it. tycostream switched that off (`TEXT_ONLY` in `postgres.ts`) and typed values by `schema.yaml` instead, a habit from before the hollow-out, when it read Materialize's `COPY` output, which carries no types. Switching it back on:

- **The database layer needs no type information.** `parseRow` only picks the source's columns.
- **node-postgres's defaults are what we want for most types:** `int8` and `numeric` stay strings, integers and floats become numbers, booleans booleans, and `json` and `jsonb` JSON.
- **Overrides for the rest:** timestamps as ISO 8601 text, as Postgres writes them in JSON and so Hasura sends them (`2026-01-01T07:30:00+00:00`), rather than JavaScript `Date`s, which put a timestamp without a time zone into the server's; dates, `interval` and `bytea` as text rather than a `Date`, an object and a `Buffer`. Materialize's own JSON writes timestamps with a space, so they're converted from the text.
- **The `SUBSCRIBE` columns** are typed too: `mz_progressed` arrives as a boolean and `mz_diff` as a string.
- **Enums** keep their names from `schema.yaml`.

### Operators

Every scalar gets Hasura's base set: `_eq`, `_neq`, `_gt`, `_gte`, `_lt`, `_lte`, `_in`, `_nin`, `_is_null`. Today strings and booleans have no orderings. `String` adds the pattern operators: `_like`, `_nlike`, `_ilike`, `_nilike`, `_similar`, `_nsimilar`, `_regex`, `_nregex`, `_iregex`, `_niregex`. `_and`, `_or` and `_not` stay as they are.

Materialize's regular expressions use Rust's syntax, not POSIX, so a pattern can behave differently than on Hasura. Materialize has no `SIMILAR TO` (checked on v26.49.1, 8 Nov), so `_similar` and `_nsimilar` are left out.

### Root fields

```graphql
type query_root {
  trades(
    where: trades_bool_exp
    order_by: [trades_order_by!]
    limit: Int
    offset: Int
  ): [trades!]!
}
```

- **No `_by_pk`:** `trades(where: { id: { _eq: 1 } })` does the same (Chris, 9 Nov).
- **`order_by`** is a list of `<source>_order_by`, applied in order; each field takes Hasura's `order_by` enum: `asc`, `asc_nulls_first`, `asc_nulls_last`, `desc`, `desc_nulls_first`, `desc_nulls_last`.
- **`limit` and `offset`** as in SQL.

## Where tycostream differs: subscriptions

Hasura's subscriptions send the whole result again on every change, or, for `_stream`, the new rows of an append-only table. tycostream's send what changed, keyed by row, so a client knows what moved (Chris, 8 Nov).

- **Hasura's root fields and arguments, our own return type:** `trades(where, order_by, limit, offset)`, returning `[trades_update!]!`, one list of updates per timestamp, as since [#18](https://github.com/tycoworks/tycostream/pull/18). The update type itself only takes Hasura's style of name.
- **A whole result on every change is a live query,** which is what Hasura's subscriptions are. If tycostream offers one, it's The Guild's way: `@live` on a query, `query @live { trades { … } }`, not a subscription (Chris, 8 Nov).
- **`order_by`, `limit` and `offset`** choose which rows the subscription covers: rows entering and leaving the window arrive as inserts and deletes. A client sorts the changes itself.

## Not in scope

- `distinct_on`, `_aggregate`, `_stream`, mutations.
- `jsonb`'s own operators (`_contains`, `_has_key`…), and arrays as GraphQL lists.
- Non-null columns other than the key. Hasura reads `NOT NULL` from the database; `schema.yaml` could say it later.
- Relationships ([#2](https://github.com/tycoworks/tycostream/issues/2)).

## To verify first

Against Materialize in Testcontainers, before the steps that depend on them:

1. ~~`ORDER BY`, `LIMIT` and `OFFSET` inside a `SUBSCRIBE`~~: Materialize keeps the window up to date; a row leaving it arrives as a −1, one entering as a +1, at one timestamp (9 Nov).
2. ~~`SIMILAR TO`~~: not supported (8 Nov). `LIKE`, `ILIKE` and the regular expression operators are.
3. Timestamps' text format.

## Steps

Each a commit, leaving tycostream building and its tests passing; all released together.

1. **Hasura's names** for the types tycostream generates.
2. **Hasura's operators.**
3. **Hasura's scalars,** in two commits:
   - **3a, Postgres types throughout:** the `PostgresType` list, Postgres's names in `schema.yaml`, the generator reading `pg_catalog`, and the API's one table to GraphQL. Arrays dropped for now.
   - **3b, parsing by the database's own types,** with the overrides above: the database layer's type switch goes, `json` and `jsonb` arrive as JSON, and timestamps in ISO 8601.
   - **3c, arrays, as GraphQL lists** (Chris, 9 Nov): node-postgres already turns them into lists once it parses by the database's types.
4. **`order_by`, `limit` and `offset`,** for queries, then subscriptions.
5. **Docs:** README, `architecture.md`, `filters.md`, `roadmap.md`. positions-app moves to the new API after the release.
