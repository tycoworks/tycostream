import * as path from 'path';
import { TestEnvironment } from '../test/utils';

// Configuration
const TEST_PORT = 4000;
const MARKET_DATA_INTERVAL_MS = 100;
const TRADE_INTERVAL_MS = 100;
const PRICE_CHANGE_PERCENT = 0.5; // Maximum price change percentage
const MAX_TRADE_QUANTITY = 10000;
const TRADE_BIAS = 0.5; // 0.5 = equal buy/sell probability

async function setupDatabase(testEnv: TestEnvironment) {
  console.log('Setting up database schema...');
  
  // Create tables
  await testEnv.executeSql(`
    CREATE TABLE instruments (
      id INT,
      symbol TEXT NOT NULL,
      name TEXT
    )
  `);

  await testEnv.executeSql(`
    CREATE TABLE trades (
      id INT,
      instrument_id INT,
      quantity INT NOT NULL,
      price NUMERIC NOT NULL,
      executed_at TIMESTAMP NOT NULL
    )
  `);

  await testEnv.executeSql(`
    CREATE TABLE market_data (
      ID INT,
      instrument_id INT NOT NULL,
      Price DOUBLE PRECISION,
      Timestamp BIGINT
    )
  `);

  // Insert instruments
  await testEnv.executeSql(`
    INSERT INTO instruments (id, symbol, name) VALUES
      (1, 'AAPL', 'Apple Inc.'),
      (2, 'GOOG', 'Alphabet Inc.'),
      (3, 'MSFT', 'Microsoft Corporation')
  `);

  // Create materialized views
  await testEnv.executeSql(`
    CREATE MATERIALIZED VIEW latest_market_data AS
      SELECT DISTINCT ON (instrument_id) instrument_id, Price, Timestamp
      FROM market_data
      ORDER BY instrument_id, Timestamp DESC
  `);

  await testEnv.executeSql(`
    CREATE MATERIALIZED VIEW live_pnl AS
      SELECT
        i.id AS instrument_id,
        i.symbol,
        SUM(t.quantity) AS net_position,
        md.Price AS last_price,
        round((ABS(SUM(t.quantity)) * md.Price)::numeric, 2) AS market_value,
        round(((SUM(t.quantity) * md.Price) - SUM(t.price * t.quantity))::numeric, 2) AS unrealized_pnl
      FROM trades AS t
      JOIN instruments AS i ON i.id = t.instrument_id
      JOIN latest_market_data AS md ON md.instrument_id = i.id
      GROUP BY i.id, i.symbol, md.Price
  `);

  console.log('Database setup complete');
}

// Track latest prices for each instrument
const latestPrices: Map<number, number> = new Map([
  [1, 170.5],
  [2, 125.9],
  [3, 310.2]
]);

let marketDataId = 1;
let tradeId = 1;

async function insertMarketData(testEnv: TestEnvironment) {
  const instrumentId = Math.floor(Math.random() * 3) + 1;
  const currentPrice = latestPrices.get(instrumentId) || 100;
  
  // Generate random price change within +/- PRICE_CHANGE_PERCENT
  const priceChange = (Math.random() - 0.5) * 2 * (PRICE_CHANGE_PERCENT / 100);
  const newPrice = +(currentPrice * (1 + priceChange)).toFixed(2);
  
  latestPrices.set(instrumentId, newPrice);
  
  const timestamp = new Date().toISOString().replace(/[-:T.]/g, '').slice(0, 14);
  
  await testEnv.executeSql(`
    INSERT INTO market_data (ID, instrument_id, Price, Timestamp) 
    VALUES ($1, $2, $3, $4)
  `, [marketDataId++, instrumentId, newPrice, parseInt(timestamp)]);
  
  console.log(`Market data: Instrument ${instrumentId} price updated to ${newPrice}`);
}

async function insertTrade(testEnv: TestEnvironment) {
  const instrumentId = Math.floor(Math.random() * 3) + 1;
  const quantity = Math.floor(Math.random() * MAX_TRADE_QUANTITY) + 1;
  // Trade bias: 0.5 = equal buy/sell, > 0.5 = more buys, < 0.5 = more sells
  const signedQuantity = Math.random() < TRADE_BIAS ? quantity : -quantity;
  const price = latestPrices.get(instrumentId) || 100;
  
  await testEnv.executeSql(`
    INSERT INTO trades (id, instrument_id, quantity, price, executed_at) 
    VALUES ($1, $2, $3, $4, NOW())
  `, [tradeId++, instrumentId, signedQuantity, price]);
  
  const side = signedQuantity > 0 ? 'BUY' : 'SELL';
  console.log(`Trade: ${side} Instrument ${instrumentId}, quantity ${Math.abs(signedQuantity)} @ ${price}`);
}

async function runLiveEnvironment() {
  console.log('Starting live tycostream environment...');
  console.log(`GraphQL endpoint will be available at http://localhost:${TEST_PORT}/graphql`);
  
  // Create test environment
  const testEnv = await TestEnvironment.create(
    TEST_PORT,
    path.join(__dirname, '..', 'schema.yaml')
  );
  
  // Setup database
  await setupDatabase(testEnv);
  
  console.log(`
Live environment running!
- GraphQL: http://localhost:${TEST_PORT}/graphql
- Market data updates every ${MARKET_DATA_INTERVAL_MS}ms
- Trade updates every ${TRADE_INTERVAL_MS}ms

Press Ctrl+C to stop
`);
  
  // Start market data updates
  const marketDataInterval = setInterval(async () => {
    try {
      await insertMarketData(testEnv);
    } catch (error) {
      console.error('Error inserting market data:', error);
    }
  }, MARKET_DATA_INTERVAL_MS);
  
  // Start trade updates
  const tradeInterval = setInterval(async () => {
    try {
      await insertTrade(testEnv);
    } catch (error) {
      console.error('Error inserting trade:', error);
    }
  }, TRADE_INTERVAL_MS);
  
  // Handle shutdown
  let shutdownInProgress = false;
  process.on('SIGINT', async () => {
    if (shutdownInProgress) {
      console.log('\nForce exit');
      process.exit(1);
    }
    shutdownInProgress = true;
    console.log('\nShutting down...');
    clearInterval(marketDataInterval);
    clearInterval(tradeInterval);
    await testEnv.stop();
    process.exit(0);
  });
}

// Run if called directly
if (require.main === module) {
  runLiveEnvironment().catch(console.error);
}

export { runLiveEnvironment };