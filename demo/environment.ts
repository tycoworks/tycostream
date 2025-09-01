import * as path from 'path';
import { TestEnvironment } from '../test/utils';

// Configuration for the live demo environment
const TEST_PORT = 4000;
const MARKET_DATA_INTERVAL_MS = 50;
const TRADE_INTERVAL_MS = 3000;
const MAX_PRICE_CHANGE = 0.1; // Maximum absolute price change (e.g. 0.1 = $0.10)
const MIN_TRADE_QUANTITY = 2000;
const MAX_TRADE_QUANTITY = 10000;
const TRADE_BIAS = 0.5; // 0.5 = equal buy/sell probability

// Maps instrument IDs to their metadata including symbol, name, current price, and initial position
const instruments = new Map([
  [1, { symbol: 'AAPL', name: 'Apple Inc.', price: 170.5, initialPosition: 1000 }],
  [2, { symbol: 'GOOG', name: 'Alphabet Inc.', price: 125.9, initialPosition: -500 }],
  [3, { symbol: 'MSFT', name: 'Microsoft Corporation', price: 310.2, initialPosition: 750 }]
]);

// Global test environment instance for managing the demo
let testEnv: TestEnvironment;

// Auto-incrementing ID counters for market data and trades
let marketDataId = 1;
let tradeId = 1;
let alertId = 1;

// Automatically start the demo when this file is executed directly
if (require.main === module) {
  runLiveEnvironment().catch(console.error);
}

/**
 * Starts a live streaming environment with simulated market data and trades
 */
async function runLiveEnvironment() {
// Create test environment with specified port and schema
  console.log(`
Starting test environment:
- GraphQL UI: http://localhost:${TEST_PORT}/graphql
- Market data updates: ${MARKET_DATA_INTERVAL_MS}ms
- Trade updates: ${TRADE_INTERVAL_MS}ms
`);
  
  testEnv = await TestEnvironment.create({
    appPort: TEST_PORT,
    schemaPath: path.join(__dirname, 'schema.yaml'),
    database: {
      host: 'localhost',
      port: 6875,
      user: 'materialize',
      password: 'materialize',
      name: 'materialize',
      workers: '1'
    },
    graphqlUI: false,
    logLevel: 'error',
    webhook: {
      port: 3001,
      endpoint: '/webhook',
      handler: async (payload) => {
        console.log('Webhook received:', JSON.stringify(payload, null, 2));
        const eventType = payload.event_type === 'MATCH' ? 'TRIGGERED' : 'CLEARED';
        await insertAlert(payload.trigger_name, eventType, payload.data);
      }
    }
  });
  console.log('Test environment created successfully');
  
  // Initialize database schema and tables
  console.log('Setting up database schema...');
  await setupDatabase();
  console.log('Database schema setup complete');
  
  // Populate initial market data and positions
  console.log('Inserting initial data...');
  await insertInitialData();
  console.log('Initial data insertion complete');
  
  // Continuously generate random market data updates
  const marketDataInterval = setInterval(async () => {
    try {
      const instrumentId = Math.floor(Math.random() * instruments.size) + 1;
      await insertMarketData(instrumentId);
    } catch (error) {
      console.error('Error inserting market data:', error);
    }
  }, MARKET_DATA_INTERVAL_MS);
  
  // Continuously generate random trade executions
  const tradeInterval = setInterval(async () => {
    try {
      const instrumentId = Math.floor(Math.random() * instruments.size) + 1;
      const quantity = Math.floor(Math.random() * (MAX_TRADE_QUANTITY - MIN_TRADE_QUANTITY + 1)) + MIN_TRADE_QUANTITY;
      const signedQuantity = Math.random() < TRADE_BIAS ? quantity : -quantity;
      await insertTrade(instrumentId, signedQuantity);
    } catch (error) {
      console.error('Error inserting trade:', error);
    }
  }, TRADE_INTERVAL_MS);
  
  // Gracefully handle shutdown on Ctrl+C
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

/**
 * Creates database tables and materialized views for the demo
 */
async function setupDatabase() {  
  // Create instruments table
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

  await testEnv.executeSql(`
    CREATE TABLE alerts (
      id INTEGER,
      timestamp TIMESTAMPTZ DEFAULT NOW(),
      trigger_name TEXT,
      event_type TEXT,
      data JSONB
    )
  `);

  // Populate instruments table from our configuration
  for (const [id, instrument] of instruments) {
    await testEnv.executeSql(`
      INSERT INTO instruments (id, symbol, name) 
      VALUES ($1, $2, $3)
    `, [id, instrument.symbol, instrument.name]);
  }

  // Create view for latest market data per instrument
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
        round((
          SUM(CASE WHEN t.quantity < 0 THEN t.price * ABS(t.quantity) ELSE 0 END) -
          SUM(CASE WHEN t.quantity > 0 THEN t.price * t.quantity ELSE 0 END)
        )::numeric, 2) as realized_pnl,
        round(((SUM(t.quantity) * md.Price) - SUM(t.price * t.quantity))::numeric, 2) AS unrealized_pnl
      FROM trades AS t
      JOIN instruments AS i ON i.id = t.instrument_id
      JOIN latest_market_data AS md ON md.instrument_id = i.id
      GROUP BY i.id, i.symbol, md.Price
  `);

  console.log('Database setup complete');
}

/**
 * Populates initial market data and positions for all instruments
 */
async function insertInitialData() {
  console.log('Inserting initial data for all instruments...');
  
  // Generate initial snapshot for each instrument
  for (const [id, instrument] of instruments) {
    // Create initial market data point
    await insertMarketData(id);
    
    // Create initial position if specified
    if (instrument.initialPosition !== 0) {
      await insertTrade(id, instrument.initialPosition);
    }
  }
  
  console.log('Initial data inserted for all instruments');
}

/**
 * Inserts a new market data record with a randomly fluctuating price
 */
async function insertMarketData(instrumentId: number) {
  const instrument = instruments.get(instrumentId)!;
  const currentPrice = instrument.price;
  
  // Calculate random price movement within configured bounds
  const priceChange = (Math.random() - 0.5) * 2 * MAX_PRICE_CHANGE;
  const newPrice = +(currentPrice + priceChange).toFixed(2);
  
  instrument.price = newPrice;
  
  const timestamp = new Date().toISOString().replace(/[-:T.]/g, '').slice(0, 14);
  
  await testEnv.executeSql(`
    INSERT INTO market_data (ID, instrument_id, Price, Timestamp) 
    VALUES ($1, $2, $3, $4)
  `, [marketDataId++, instrumentId, newPrice, parseInt(timestamp)]);
  
  console.log(`Market data: Instrument ${instrumentId} price updated to ${newPrice}`);
}

/**
 * Inserts a trade record at the current market price
 */
async function insertTrade(instrumentId: number, quantity: number) {
  const instrument = instruments.get(instrumentId)!;
  const price = instrument.price;
  
  await testEnv.executeSql(`
    INSERT INTO trades (id, instrument_id, quantity, price, executed_at) 
    VALUES ($1, $2, $3, $4, NOW())
  `, [tradeId++, instrumentId, quantity, price]);
  
  const side = quantity > 0 ? 'BUY' : 'SELL';
  console.log(`Trade: ${side} Instrument ${instrumentId}, quantity ${Math.abs(quantity)} @ ${price}`);
}

/**
 * Inserts an alert record from a webhook payload
 */
async function insertAlert(triggerName: string, eventType: string, data: any) {
  await testEnv.executeSql(`
    INSERT INTO alerts (id, trigger_name, event_type, data)
    VALUES ($1, $2, $3, $4)
  `, [
    alertId++,
    triggerName,
    eventType,
    JSON.stringify(data)
  ]);
  
  console.log(`Alert inserted: ${triggerName} - ${eventType}`);
}

export { runLiveEnvironment };