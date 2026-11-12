#!/usr/bin/env bash
# Starts the Materialize the test cases connect to, on localhost:6878, and loads
# their two databases: positions_app (positions-app's tables and views) and shop
# (customers, orders, order_lines with no single-column key, and products with
# an array column). Stop it afterwards with: docker stop create-schema-evals
set -eu

export PGPASSWORD=materialize PGOPTIONS='--client_min_messages=warning'
mz() { psql -h localhost -p 6878 -U materialize -q -v ON_ERROR_STOP=1 "$@"; }

docker run -d --rm --name create-schema-evals -p 6878:6875 materialize/materialized:v26.49.0 >/dev/null
until mz -d materialize -c 'SELECT 1' >/dev/null 2>&1; do sleep 2; done

mz -d materialize -c 'CREATE DATABASE positions_app' -c 'CREATE DATABASE shop'

mz -d positions_app \
  -c 'CREATE TABLE instruments (id integer NOT NULL, symbol text NOT NULL, name text)' \
  -c 'CREATE TABLE trades (id integer NOT NULL, instrument_id integer, quantity integer NOT NULL, price numeric NOT NULL, executed_at timestamp NOT NULL)' \
  -c 'CREATE TABLE market_data (symbol text NOT NULL, price numeric NOT NULL, timestamp bigint NOT NULL)' \
  -c "INSERT INTO instruments VALUES (1, 'AAPL', 'Apple Inc.'), (2, 'GOOG', 'Alphabet Inc.'), (3, 'MSFT', 'Microsoft Corporation')" \
  -c "INSERT INTO trades VALUES (1, 1, 500, 198.40, '2025-06-02 14:31:07'), (2, 1, 300, 200.10, '2025-06-02 15:02:44'), (3, 1, -200, 203.20, '2025-06-02 16:18:30'), (4, 2, 200, 172.30, '2025-06-02 14:45:12'), (5, 2, 150, 174.75, '2025-06-02 17:09:58'), (6, 3, -800, 462.20, '2025-06-02 14:52:21'), (7, 3, 300, 458.40, '2025-06-02 18:37:05')" \
  -c "INSERT INTO market_data VALUES ('AAPL', 216.94, 1762900000000), ('GOOG', 183.39, 1762900000000), ('MSFT', 444.43, 1762900000000)" \
  -c 'CREATE MATERIALIZED VIEW latest_market_data AS SELECT DISTINCT ON (symbol) symbol, price, timestamp FROM market_data ORDER BY symbol, timestamp DESC' \
  -c 'CREATE MATERIALIZED VIEW positions AS
        SELECT i.id AS instrument_id, i.symbol, SUM(t.quantity) AS net_position, md.price AS latest_price,
               SUM(t.quantity) * md.price AS market_value,
               SUM(t.price * t.quantity) / NULLIF(SUM(t.quantity), 0) AS avg_cost_basis,
               SUM(t.quantity) * md.price - SUM(t.price * t.quantity) AS theoretical_pnl
        FROM trades AS t
        JOIN instruments AS i ON i.id = t.instrument_id
        JOIN latest_market_data AS md ON md.symbol = i.symbol
        GROUP BY i.id, i.symbol, md.price'

mz -d shop \
  -c 'CREATE TABLE customers (id integer NOT NULL, name text NOT NULL, tier text NOT NULL)' \
  -c 'CREATE TABLE orders (id integer NOT NULL, customer_id integer NOT NULL, status text NOT NULL, total numeric NOT NULL, placed_at timestamptz NOT NULL)' \
  -c 'CREATE TABLE order_lines (order_id integer NOT NULL, line_no integer NOT NULL, sku text NOT NULL, quantity integer NOT NULL)' \
  -c 'CREATE TABLE products (sku text NOT NULL, name text NOT NULL, tags text[])' \
  -c "INSERT INTO customers VALUES (1, 'Ada Lovelace', 'gold'), (2, 'Alan Turing', 'standard'), (3, 'Grace Hopper', 'platinum'), (4, 'Edsger Dijkstra', 'standard')" \
  -c "INSERT INTO orders VALUES (101, 1, 'paid', 59.90, '2026-11-01 09:12:00+00'), (102, 2, 'pending', 12.50, '2026-11-02 14:03:00+00'), (103, 1, 'shipped', 240.00, '2026-11-03 08:45:00+00'), (104, 3, 'cancelled', 18.00, '2026-11-04 17:30:00+00'), (105, 4, 'paid', 75.25, '2026-11-05 11:00:00+00')" \
  -c "INSERT INTO order_lines VALUES (101, 1, 'MUG-01', 2), (101, 2, 'TEE-02', 1), (102, 1, 'MUG-01', 1), (103, 1, 'HOOD-03', 3), (103, 2, 'TEE-02', 2), (104, 1, 'CAP-04', 1), (105, 1, 'HOOD-03', 1)" \
  -c "INSERT INTO products VALUES ('MUG-01', 'Logo mug', '{kitchen,gift}'), ('TEE-02', 'Logo tee', '{apparel}'), ('HOOD-03', 'Hoodie', '{apparel,winter}'), ('CAP-04', 'Cap', NULL)"

echo "Materialize is on localhost:6878, with the databases positions_app and shop"
