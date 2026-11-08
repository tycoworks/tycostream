# Plan: a Hasura-compatible API

Status: draft, 8 Nov 2026; not yet agreed. Branch: `hasura-compatibility`. Breaks clients, so it's released as `v0.4.0`. Follows one message per timestamp, a separate change; comes before relationships ([relationships.md](./relationships.md)).

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

tycostream's own types take the same style: `row_operation`, `trades_batch`, `trades_change`.

### Scalars

Hasura names each column's GraphQL type after its Postgres type. `schema.yaml`'s types are tycostream's own (`Integer`, `Float`, `BigInt`…), and several collapse: `numeric` becomes `Float`, losing precision, and timestamps, `uuid` and `bigint` become `String` or `ID`. Instead, `schema.yaml` columns take Postgres type names, as the database reports them (Chris, 8 Nov), and each becomes Hasura's scalar. Materialize and RisingWave both use Postgres's names, so the file stays the same for either.

| `schema.yaml` | GraphQL | Today |
|---|---|---|
| `smallint` | `smallint` | `Int` |
| `integer` | `Int` | `Int` |
| `bigint` | `bigint` | `String` |
| `real` | `Float` | `Float` |
| `double precision` | `float8` | `Float` |
| `numeric` | `numeric` | `Float` |
| `text`, `varchar`, `char` | `String` | `String` |
| `boolean` | `Boolean` | `Boolean` |
| `uuid` | `uuid` | `ID` |
| `timestamp`, `timestamptz` | `timestamp`, `timestamptz` | `String` |
| `date`, `time` | `date`, `time` | `String` |
| `json`, `jsonb` | `json`, `jsonb` | `String` |

- **`bigint` and `numeric` are sent as strings,** to keep their precision, as Hasura does with `HASURA_GRAPHQL_STRINGIFY_NUMERIC_TYPES` (not its default). That mode also sends `float8` as a string; we don't, since a JSON number holds a `float8` exactly. As inputs, these scalars take a number or a string.
- **`smallint`** is its own scalar in Hasura's code, though its docs say `Int`.
- **Timestamps as Hasura sends them,** in ISO 8601 (`2026-11-08T10:00:00+00:00`), not Materialize's text form, which has a space. The exact format is to confirm.
- **Enums** keep their names from `schema.yaml`.
- **`scripts/generate-schema.sh`** writes the database's type names as they are.

### Operators

Every scalar gets Hasura's base set: `_eq`, `_neq`, `_gt`, `_gte`, `_lt`, `_lte`, `_in`, `_nin`, `_is_null`. Today strings and booleans have no orderings. `String` adds the pattern operators: `_like`, `_nlike`, `_ilike`, `_nilike`, `_similar`, `_nsimilar`, `_regex`, `_nregex`, `_iregex`, `_niregex`. `_and`, `_or` and `_not` stay as they are.

Materialize's regular expressions use Rust's syntax, not POSIX, so a pattern can behave differently than on Hasura. Whether Materialize supports `SIMILAR TO` is to confirm; if not, `_similar` and `_nsimilar` are left out.

### Root fields

```graphql
type query_root {
  trades(
    where: trades_bool_exp
    order_by: [trades_order_by!]
    limit: Int
    offset: Int
  ): [trades!]!
  trades_by_pk(id: Int!): trades
}
```

- **`<source>_by_pk`** takes the primary key and returns the row, or null. Every source has a primary key, so every source gets one.
- **`order_by`** is a list of `<source>_order_by`, applied in order; each field takes Hasura's `order_by` enum: `asc`, `asc_nulls_first`, `asc_nulls_last`, `desc`, `desc_nulls_first`, `desc_nulls_last`.
- **`limit` and `offset`** as in SQL.

## Where tycostream differs: subscriptions

Hasura's subscriptions send the whole result again on every change, or, for `_stream`, the new rows of an append-only table. tycostream's send what changed, keyed by row, so a client knows what moved (Chris, 8 Nov).

- **Hasura's root fields and arguments, our own return type:** `trades(where, order_by, limit, offset)` and `trades_by_pk(id)`, each returning the changes. This plan only renames that type in Hasura's style; one message per timestamp, the change before this one, defines it.
- **A whole result on every change is a live query,** which is what Hasura's subscriptions are. If tycostream offers one, it's The Guild's way: `@live` on a query, `query @live { trades { … } }`, not a subscription (Chris, 8 Nov).
- **`order_by`, `limit` and `offset`** choose which rows the subscription covers: rows entering and leaving the window arrive as inserts and deletes. A client sorts the changes itself.

## Not in scope

- `distinct_on`, `_aggregate`, `_stream`, mutations.
- `jsonb`'s own operators (`_contains`, `_has_key`…), and arrays as GraphQL lists.
- Non-null columns other than the key. Hasura reads `NOT NULL` from the database; `schema.yaml` could say it later.
- Relationships ([relationships.md](./relationships.md)).

## To verify first

Against Materialize in Testcontainers, before the steps that depend on them:

1. `ORDER BY`, `LIMIT` and `OFFSET` inside a `SUBSCRIBE`: does Materialize keep the window up to date, with rows entering and leaving it?
2. `SIMILAR TO`, and how far Materialize's regular expressions differ from Postgres's.
3. Timestamps' text format.

## Steps

Each a commit, leaving tycostream building and its tests passing; all released together.

1. **Hasura's names** for the types tycostream generates.
2. **Hasura's operators.**
3. **Hasura's scalars:** Postgres type names in `schema.yaml`, the scalars, the value formats, and the generator script.
4. **`_by_pk`,** for queries and subscriptions.
5. **`order_by`, `limit` and `offset`,** for queries, then subscriptions.
6. **Docs:** README, `architecture.md`, `filters.md`, `roadmap.md`. positions-app moves to the new API after the release.
