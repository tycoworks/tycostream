/**
 * Test utilities to reduce code duplication across test files
 * Provides common test data, setup helpers, and timing utilities
 */

import { ViewCache } from '../shared/viewCache.js';
import { ClientStreamHandler } from '../shared/clientStreamHandler.js';

// Test-specific constants to reduce duplication
export const TEST_CONSTANTS = {
  PRIMARY_KEY_FIELD: 'id',
  VIEW_NAME: 'test_view',
  
  // Sample data for consistent testing
  SAMPLE_ROWS: {
    BASIC: { id: '1', name: 'test', value: 10 },
    UPDATED: { id: '1', name: 'updated', value: 20 },
    SECOND: { id: '2', name: 'second', value: 30 },
  },
  
  // Client identifiers for testing
  CLIENT_IDS: {
    FIRST: 'client-1',
    SECOND: 'client-2', 
    THIRD: 'client-3',
    CUSTOM: 'custom-id',
  },
} as const;

// Test timing constants
const TEST_DELAY_SHORT = 10;    // Quick async operations in tests
const TEST_DELAY_MEDIUM = 50;   // Component initialization in tests  
const TEST_DELAY_LONG = 100;    // Integration test coordination

/**
 * Create a standard test ViewCache instance
 */
export function createTestCache(
  primaryKeyField: string = TEST_CONSTANTS.PRIMARY_KEY_FIELD,
  viewName: string = TEST_CONSTANTS.VIEW_NAME
): ViewCache {
  return new ViewCache(primaryKeyField, viewName);
}

/**
 * Create a test ClientStreamHandler instance
 */
export function createTestClient(
  cache: ViewCache,
  clientId?: string,
  viewName: string = TEST_CONSTANTS.VIEW_NAME
): ClientStreamHandler {
  return new ClientStreamHandler(viewName, cache, clientId);
}

/**
 * Standard test delays for async operations
 */
export const TEST_DELAYS = {
  SHORT: () => new Promise(resolve => setTimeout(resolve, TEST_DELAY_SHORT)),
  MEDIUM: () => new Promise(resolve => setTimeout(resolve, TEST_DELAY_MEDIUM)), 
  LONG: () => new Promise(resolve => setTimeout(resolve, TEST_DELAY_LONG)),
} as const;

/**
 * Common test data factory functions
 */
export const TestData = {
  /**
   * Create a basic test row
   */
  basicRow: (id: string = '1', name: string = 'test', value: number = 10) => ({
    id, name, value
  }),

  /**
   * Create multiple test rows with incremental IDs
   */
  multipleRows: (count: number = 3, baseValue: number = 10) => 
    Array.from({ length: count }, (_, i) => ({
      id: String(i + 1),
      name: `item${i + 1}`,
      value: baseValue * (i + 1)
    })),

  /**
   * Create a stream event for testing
   */
  streamEvent: (row: Record<string, any>, diff: number = 1) => ({
    row,
    diff
  }),
} as const;

/**
 * Mock environment helper for consistent test setup
 */
export function mockTestEnvironment() {
  const originalEnv = process.env;
  
  // Set test environment variables
  process.env.NODE_ENV = 'test';
  process.env.LOG_LEVEL = 'debug';
  process.env.GRAPHQL_PORT = '4000';
  process.env.SOURCE_PORT = '6875';
  
  return () => {
    // Restore original environment
    process.env = originalEnv;
  };
}

/**
 * Async event collector for testing event sequences
 */
export class EventCollector<T = any> {
  private events: T[] = [];
  private expectedCount: number;
  private resolvePromise?: (events: T[]) => void;
  private promise?: Promise<T[]>;

  constructor(expectedCount: number) {
    this.expectedCount = expectedCount;
  }

  /**
   * Add an event to the collection
   */
  add(event: T): void {
    this.events.push(event);
    
    if (this.events.length >= this.expectedCount && this.resolvePromise) {
      this.resolvePromise([...this.events]);
    }
  }

  /**
   * Wait for the expected number of events
   */
  async waitFor(timeoutMs: number = 1000): Promise<T[]> {
    if (this.events.length >= this.expectedCount) {
      return [...this.events];
    }

    this.promise = new Promise((resolve, reject) => {
      this.resolvePromise = resolve;
      
      setTimeout(() => {
        reject(new Error(`Timeout waiting for ${this.expectedCount} events, got ${this.events.length}`));
      }, timeoutMs);
    });

    return this.promise;
  }

  /**
   * Get current events without waiting
   */
  get current(): T[] {
    return [...this.events];
  }

  /**
   * Reset the collector
   */
  reset(): void {
    this.events = [];
    this.resolvePromise = undefined;
    this.promise = undefined;
  }
}

/**
 * Helper to create mock subscribers for testing
 */
export function createMockSubscriber() {
  const events: any[] = [];
  
  return {
    onUpdate: (event: any) => events.push(event),
    events: () => [...events],
    clear: () => events.length = 0,
    count: () => events.length,
  };
}