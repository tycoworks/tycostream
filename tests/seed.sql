-- Tables
CREATE TABLE instruments (
  id INT,
  symbol TEXT NOT NULL,
  name TEXT
);

CREATE TABLE trades (
  id INT,
  instrument_id INT,
  quantity INT NOT NULL,
  price NUMERIC NOT NULL,
  executed_at TIMESTAMP NOT NULL
);

CREATE TABLE market_data (
  ID INT,
  instrument_id INT NOT NULL,
  Price DOUBLE PRECISION,
  Timestamp BIGINT
);

-- Inserts: Instruments
INSERT INTO instruments (id, symbol, name) VALUES
  (1, 'AAPL', 'Apple Inc.'),
  (2, 'GOOG', 'Alphabet Inc.'),
  (3, 'MSFT', 'Microsoft Corporation');

-- Inserts: Trades
INSERT INTO trades (id, instrument_id, quantity, price, executed_at) VALUES
  (1, 1, 100, 170.5, '2025-05-26 10:00:00'),
  (2, 1, 50, 172.1, '2025-05-26 10:01:00'),
  (3, 2, 75, 125.9, '2025-05-26 10:00:30'),
  (4, 3, 200, 310.2, '2025-05-26 10:02:00');

-- Inserts: Market Data
INSERT INTO market_data (ID, instrument_id, Price, Timestamp) VALUES
  (1, 1, 170.5, 20250526100000),
  (2, 2, 125.9, 20250526100030),
  (3, 3, 310.2, 20250526100200);

-- Materialized Views
CREATE MATERIALIZED VIEW latest_market_data AS
  SELECT DISTINCT ON (instrument_id) instrument_id, Price, Timestamp
  FROM market_data
  ORDER BY instrument_id, Timestamp DESC;

CREATE MATERIALIZED VIEW live_pnl AS
  SELECT
    i.id AS instrument_id,
    i.symbol,
    SUM(t.quantity) AS net_position,
    md.Price AS latest_price,
    SUM(t.quantity) * md.Price AS market_value,
    SUM(t.price * t.quantity) / NULLIF(SUM(t.quantity), 0) AS avg_cost_basis,
    (SUM(t.quantity) * md.Price) - SUM(t.price * t.quantity) AS theoretical_pnl
  FROM trades AS t
  JOIN instruments AS i ON i.id = t.instrument_id
  JOIN latest_market_data AS md ON md.instrument_id = i.id
  GROUP BY i.id, i.symbol, md.Price;