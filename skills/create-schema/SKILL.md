---
name: create-schema
description: Write or update the schema.yaml that tycostream serves a GraphQL API from, by reading the user's tables and views in Materialize or another Postgres-compatible database. Picks each view's primary key, spots enums and foreign keys, confirms them with the user, and checks them against the data. Use whenever someone wants to set up tycostream, write or edit schema.yaml, add a table or view to their tycostream API, declare a foreign key or an enum, or serve Materialize views over GraphQL, even if they don't name schema.yaml.
compatibility: Needs psql, and a connection to the database.
---

# Create a schema

## What you are making

tycostream serves the tables and views listed in `schema.yaml` as a GraphQL API. The guide's [step 1](https://github.com/tycoworks/tycostream/blob/main/docs/guide.md#step-1-describe-your-schema) describes the file. It needs three things the database doesn't record: each view's primary key, which text columns are enums, and which columns reference another view. You find likely answers in the database, check them against the data, confirm them with the user in one question, and write the file with tycostream's schema generator.

## Connect

The generator connects with tycostream's `DATABASE_*` [settings](https://github.com/tycoworks/tycostream/blob/main/docs/guide.md#step-2-run-tycostream), read from the environment or a `.env` file in the current folder. Run your own queries with the same settings:

```bash
PGPASSWORD="$DATABASE_PASSWORD" PGOPTIONS='--client_min_messages=warning' \
  psql -h "$DATABASE_HOST" -p "$DATABASE_PORT" -U "$DATABASE_USER" -d "$DATABASE_NAME" -t -A -c "<one query>"
```

Run one statement per `-c`: Materialize refuses several in one transaction. `PGOPTIONS` quiets the welcome Materialize prints on every connection. If the connection fails, say which setting to fix and stop.

## Steps

### 1. Choose the tables and views

If the user named them, use those. Otherwise list what's there and ask which to serve:

```sql
SELECT table_schema, table_name, table_type FROM information_schema.tables
WHERE table_schema NOT IN ('pg_catalog', 'information_schema', 'mz_catalog', 'mz_internal', 'mz_introspection', 'mz_unsafe')
ORDER BY 1, 2;
```

If `schema.yaml` already exists, read it first. Keep every source, key, enum and foreign key in it, and add to them: the generator rewrites the whole file, so you rerun it with the old decisions as well as the new ones.

### 2. Read each one's columns

```sql
SELECT column_name, data_type FROM information_schema.columns
WHERE table_name = '<view>' ORDER BY ordinal_position;
```

Check each column's type against the [types tycostream serves](https://github.com/tycoworks/tycostream/blob/main/docs/api.md#types). Note any column of another type, such as an array: the user can drop it from the view or cast it.

### 3. Pick the primary key

Materialize views have no declared keys, so propose one from the column names (`id`, or `<name>_id` for the thing the view is about) and check it before asking:

```sql
SELECT count(*), count(<key>), count(DISTINCT <key>) FROM <view>;
```

The key is good when all three counts are equal: no nulls, no repeats. A wrong key makes a subscription fail at runtime, so the user confirms every key, even a good one.

If no single column is unique, say so, and suggest adding one in the view, such as a column that joins the values that are unique together. Don't write a file with a key that isn't unique.

### 4. Spot enums

An enum fixes a text column's values in the API, so suggest one only where the column names a category (`side`, `status`, `type`) and holds a handful of values:

```sql
SELECT DISTINCT <column> FROM <view> ORDER BY 1 LIMIT 50;
```

The user decides two things, because the data can't:

- **Every value the column can hold.** The data shows today's values only. A value missing from the enum fails any query or subscription that reads it, so ask about values that haven't appeared yet, such as `refunded`.
- **Their order.** [Filters](https://github.com/tycoworks/tycostream/blob/main/docs/api.md#filters) compare an enum's values in the file's order, so propose their natural order, such as a rank or a lifecycle.

Name the enum after what it means (`trade_side`), and reuse one enum for columns that share the same values.

### 5. Spot foreign keys

Propose a foreign key where a column names another chosen source's key, as `trades.instrument_id` names `positions.instrument_id`, and check that every value has a match:

```sql
SELECT count(*) FROM <view> v
WHERE v.<column> IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM <other> o WHERE o.<other_key> = v.<column>);
```

Zero means every value that isn't null has a match. The guide's [current limitations](https://github.com/tycoworks/tycostream/blob/main/docs/guide.md#current-limitations) rule out some foreign keys, such as two between the same sources (a buyer and a seller account). If a proposal runs into one, the user picks which to keep.

### 6. Confirm with the user

Ask once, with every proposal together, so the user can correct them all in one reply. Show a table of what the file will serve, with what the checks found:

| Source | Primary key | Enums | Foreign keys |
|---|---|---|---|
| positions | `instrument_id`: 3 rows, no nulls or repeats | | |
| trades | `id`: 7 rows, no nulls or repeats | `side` as `trade_side`: buy, sell | `instrument_id` → positions: every value matches |

Then list what only the user can answer: values each enum may hold that the data doesn't show yet, the order you proposed, columns tycostream can't serve, views with no unique column, and foreign keys the limitations rule out. Leave out anything the user has already told you.

If the user can't answer, such as when they say they're away, go with your proposals, and list them in step 8 as calls for the user to check.

### 7. Write the file

Run tycostream's schema generator, `scripts/generate-schema.sh` in this skill's directory, with every source and decision. The guide's [step 1](https://github.com/tycoworks/tycostream/blob/main/docs/guide.md#step-1-describe-your-schema) explains its flags.

```bash
bash <this skill's directory>/scripts/generate-schema.sh -e trade_side "buy,sell" \
  -s positions -p instrument_id \
  -s trades -p id -c side:trade_side -f instrument_id:positions > schema.yaml
```

The generator reads each column's exact type from the database, so don't edit the types it writes. If a column has a type tycostream doesn't serve and the user chose to keep the view as it is, remove that column from the file.

### 8. Check it

Read `schema.yaml` back, and check that it holds each source, key, enum and foreign key the user agreed. Then tell the user, briefly:

- what the file serves: each source, its key, and its enums and foreign keys;
- what you checked against the data, and anything you left out and why;
- any calls the user didn't confirm, for them to check;
- the next step: run tycostream with the file, as its [guide](https://github.com/tycoworks/tycostream/blob/main/docs/guide.md#step-2-run-tycostream) says.
