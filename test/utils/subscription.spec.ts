import { SubscriptionProcessor } from './subscription';
import { GraphQLRowOperation } from './events';

describe('SubscriptionProcessor', () => {
  let processor: SubscriptionProcessor;
  
  describe('with Map-based expected state', () => {
    beforeEach(() => {
      const expectedState = new Map([
        [1, { id: 1, name: 'Alice', age: 30 }],
        [2, { id: 2, name: 'Bob', age: 25 }],
        [3, { id: 3, name: 'Charlie', age: 35 }]
      ]);
      
      processor = new SubscriptionProcessor(
        expectedState,
        'data',  // dataPath
        'id'     // idField
      );
    });
    
    describe('INSERT operations', () => {
      it('should process INSERT for expected item', () => {
        const event = {
          operation: GraphQLRowOperation.Insert,
          data: { id: 1, name: 'Alice', age: 30 },
          fields: ['id', 'name', 'age']
        };
        
        processor.processEvent(event);
        
        const stats = processor.getStats();
        expect(stats.totalExpected).toBe(3);
        expect(stats.totalReceived).toBe(1);
        expect(processor.isComplete()).toBe(false);
      });
      
      it('should track unexpected INSERT', () => {
        const event = {
          operation: GraphQLRowOperation.Insert,
          data: { id: 99, name: 'Unknown', age: 40 },
          fields: ['id', 'name', 'age']
        };
        
        processor.processEvent(event);
        
        const stats = processor.getStats();
        expect(stats.totalExpected).toBe(3);
        expect(stats.totalReceived).toBe(0); // Unexpected items don't count
        expect(processor.isComplete()).toBe(false);
      });
      
      it('should detect state mismatch on wrong data', () => {
        const event = {
          operation: GraphQLRowOperation.Insert,
          data: { id: 1, name: 'Alice', age: 31 }, // Wrong age
          fields: ['id', 'name', 'age']
        };
        
        processor.processEvent(event);
        
        expect(processor.isComplete()).toBe(false);
        // State doesn't match expected
      });
    });
    
    describe('UPDATE operations', () => {
      it('should merge UPDATE with existing data', () => {
        // First INSERT
        processor.processEvent({
          operation: GraphQLRowOperation.Insert,
          data: { id: 1, name: 'Alice', age: 30 },
          fields: ['id', 'name', 'age']
        });
        
        // Then UPDATE with partial data
        processor.processEvent({
          operation: GraphQLRowOperation.Update,
          data: { id: 1, name: 'Alice Updated' },
          fields: ['id', 'name']
        });
        
        // Should still track as one item with merged data
        const stats = processor.getStats();
        expect(stats.totalExpected).toBe(3);
        expect(stats.totalReceived).toBe(1);
      });
      
      it('should handle UPDATE before INSERT', () => {
        // UPDATE for item we haven't seen yet
        processor.processEvent({
          operation: GraphQLRowOperation.Update,
          data: { id: 1, name: 'Alice' },
          fields: ['id', 'name']
        });
        
        // Should create partial entry
        const stats = processor.getStats();
        expect(stats.totalReceived).toBe(1);
      });
      
      it('should accumulate partial updates', () => {
        // Multiple partial updates
        processor.processEvent({
          operation: GraphQLRowOperation.Update,
          data: { id: 1, name: 'Alice' },
          fields: ['id', 'name']
        });
        
        processor.processEvent({
          operation: GraphQLRowOperation.Update,
          data: { id: 1, age: 30 },
          fields: ['id', 'age']
        });
        
        // Should merge into complete record
        const stats = processor.getStats();
        expect(stats.totalReceived).toBe(1);
        expect(processor.isComplete()).toBe(false); // Still need other items
      });
    });
    
    describe('DELETE operations', () => {
      it('should remove item on DELETE', () => {
        // First INSERT
        processor.processEvent({
          operation: GraphQLRowOperation.Insert,
          data: { id: 1, name: 'Alice', age: 30 },
          fields: ['id', 'name', 'age']
        });
        
        // Then DELETE
        processor.processEvent({
          operation: GraphQLRowOperation.Delete,
          data: { id: 1 },
          fields: ['id']
        });
        
        // Item should be removed
        const stats = processor.getStats();
        expect(stats.totalReceived).toBe(0);
      });
      
      it('should handle DELETE for non-existent item', () => {
        // DELETE for item we never saw
        processor.processEvent({
          operation: GraphQLRowOperation.Delete,
          data: { id: 99 },
          fields: ['id']
        });
        
        // Should not affect state
        const stats = processor.getStats();
        expect(stats.totalReceived).toBe(0);
        expect(processor.isComplete()).toBe(false);
      });
    });
    
    describe('completion detection', () => {
      it('should detect completion when state matches exactly', () => {
        // Insert all expected items
        processor.processEvent({
          operation: GraphQLRowOperation.Insert,
          data: { id: 1, name: 'Alice', age: 30 },
          fields: ['id', 'name', 'age']
        });
        
        processor.processEvent({
          operation: GraphQLRowOperation.Insert,
          data: { id: 2, name: 'Bob', age: 25 },
          fields: ['id', 'name', 'age']
        });
        
        expect(processor.isComplete()).toBe(false);
        
        processor.processEvent({
          operation: GraphQLRowOperation.Insert,
          data: { id: 3, name: 'Charlie', age: 35 },
          fields: ['id', 'name', 'age']
        });
        
        expect(processor.isComplete()).toBe(true);
      });
      
      it('should not be complete with extra items', () => {
        // Insert all expected items
        processor.processEvent({
          operation: GraphQLRowOperation.Insert,
          data: { id: 1, name: 'Alice', age: 30 },
          fields: ['id', 'name', 'age']
        });
        
        processor.processEvent({
          operation: GraphQLRowOperation.Insert,
          data: { id: 2, name: 'Bob', age: 25 },
          fields: ['id', 'name', 'age']
        });
        
        processor.processEvent({
          operation: GraphQLRowOperation.Insert,
          data: { id: 3, name: 'Charlie', age: 35 },
          fields: ['id', 'name', 'age']
        });
        
        // Add unexpected item
        processor.processEvent({
          operation: GraphQLRowOperation.Insert,
          data: { id: 4, name: 'David', age: 40 },
          fields: ['id', 'name', 'age']
        });
        
        expect(processor.isComplete()).toBe(false); // Has extra item
      });
      
      it('should handle completion through updates', () => {
        // Build up state through partial updates
        processor.processEvent({
          operation: GraphQLRowOperation.Insert,
          data: { id: 1, name: 'Alice' },
          fields: ['id', 'name']
        });
        
        processor.processEvent({
          operation: GraphQLRowOperation.Update,
          data: { id: 1, age: 30 },
          fields: ['id', 'age']
        });
        
        processor.processEvent({
          operation: GraphQLRowOperation.Insert,
          data: { id: 2, name: 'Bob', age: 25 },
          fields: ['id', 'name', 'age']
        });
        
        processor.processEvent({
          operation: GraphQLRowOperation.Insert,
          data: { id: 3, name: 'Charlie', age: 35 },
          fields: ['id', 'name', 'age']
        });
        
        expect(processor.isComplete()).toBe(true);
      });
    });
    
    describe('edge cases', () => {
      it('should handle null/undefined fields', () => {
        const event = {
          operation: GraphQLRowOperation.Insert,
          data: { id: 1, name: 'Alice', age: null },
          fields: ['id', 'name', 'age']
        };
        
        processor.processEvent(event);
        
        const stats = processor.getStats();
        expect(stats.totalReceived).toBe(1);
      });
      
      it('should handle missing dataPath', () => {
        // Create processor without nested data path
        const simpleProcessor = new SubscriptionProcessor(
          new Map([[1, { id: 1, name: 'Test' }]]),
          '',  // No data path means event IS the data  
          'id'
        );
        
        // When dataPath is empty, the whole event is the data
        const event = {
          id: 1,
          name: 'Test',
          operation: GraphQLRowOperation.Insert
        };
        
        simpleProcessor.processEvent(event);
        expect(simpleProcessor.isComplete()).toBe(true);
      });
      
      it('should handle complex nested objects', () => {
        const complexProcessor = new SubscriptionProcessor(
          new Map([[1, { 
            id: 1, 
            profile: { 
              name: 'Alice',
              settings: { theme: 'dark' }
            }
          }]]),
          'data',
          'id'
        );
        
        complexProcessor.processEvent({
          operation: GraphQLRowOperation.Insert,
          data: { 
            id: 1, 
            profile: { 
              name: 'Alice',
              settings: { theme: 'dark' }
            }
          },
          fields: ['id', 'profile']
        });
        
        expect(complexProcessor.isComplete()).toBe(true);
      });
    });
  });
  
  describe('with empty expected state', () => {
    beforeEach(() => {
      processor = new SubscriptionProcessor(
        new Map(),  // Empty expected state
        'data',
        'id'
      );
    });
    
    it('should be complete immediately', () => {
      expect(processor.isComplete()).toBe(true);
    });
    
    it('should not be complete after receiving events', () => {
      processor.processEvent({
        operation: GraphQLRowOperation.Insert,
        data: { id: 1, name: 'Alice' },
        fields: ['id', 'name']
      });
      
      expect(processor.isComplete()).toBe(false); // Has unexpected item
    });
  });
});