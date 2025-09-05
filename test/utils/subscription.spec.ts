import { SubscriptionProcessor } from './subscription';
import { GraphQLRowOperation } from './events';

describe('SubscriptionProcessor', () => {
  let processor: SubscriptionProcessor;
  
  // Helper to create properly formatted events
  const createEvent = (operation: string, rowData: any, fields: string[]) => ({
    data: {
      operation,
      data: rowData,
      fields
    }
  });
  
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
        const event = createEvent(
          GraphQLRowOperation.Insert,
          { id: 1, name: 'Alice', age: 30 },
          ['id', 'name', 'age']
        );
        
        processor.processEvent(event);
        
        const stats = processor.getStats();
        expect(stats.totalExpected).toBe(3);
        expect(stats.totalReceived).toBe(1);
        expect(processor.isComplete()).toBe(false);
      });
      
      it('should track unexpected INSERT', () => {
        const event = createEvent(
          GraphQLRowOperation.Insert,
          { id: 99, name: 'Unknown', age: 40 },
          ['id', 'name', 'age']
        );
        
        processor.processEvent(event);
        
        const stats = processor.getStats();
        expect(stats.totalExpected).toBe(3);
        expect(stats.totalReceived).toBe(1); // Unexpected items ARE counted in currentState
        expect(processor.isComplete()).toBe(false); // But they prevent completion
      });
      
      it('should detect state mismatch on wrong data', () => {
        const event = createEvent(
          GraphQLRowOperation.Insert,
          { id: 1, name: 'Alice', age: 31 }, // Wrong age
          ['id', 'name', 'age']
        );
        
        processor.processEvent(event);
        
        expect(processor.isComplete()).toBe(false);
        // State doesn't match expected
      });
      
      it('should throw on duplicate INSERT', () => {
        // First INSERT
        processor.processEvent(createEvent(
          GraphQLRowOperation.Insert,
          { id: 1, name: 'Alice', age: 30 },
          ['id', 'name', 'age']
        ));
        
        // Duplicate INSERT should throw
        expect(() => {
          processor.processEvent(createEvent(
            GraphQLRowOperation.Insert,
            { id: 1, name: 'Alice', age: 30 },
            ['id', 'name', 'age']
          ));
        }).toThrow('Received duplicate INSERT for item 1');
      });
    });
    
    describe('UPDATE operations', () => {
      it('should merge UPDATE with existing data', () => {
        // First INSERT
        processor.processEvent(createEvent(
          GraphQLRowOperation.Insert,
          { id: 1, name: 'Alice', age: 30 },
          ['id', 'name', 'age']
        ));
        
        // Then UPDATE with partial data
        processor.processEvent(createEvent(
          GraphQLRowOperation.Update,
          { id: 1, name: 'Alice Updated' },
          ['id', 'name']
        ));
        
        // Should still track as one item with merged data
        const stats = processor.getStats();
        expect(stats.totalExpected).toBe(3);
        expect(stats.totalReceived).toBe(1);
      });
      
      it('should throw on UPDATE before INSERT', () => {
        // UPDATE for item we haven't seen yet should throw
        expect(() => {
          processor.processEvent(createEvent(
            GraphQLRowOperation.Update,
            { id: 1, name: 'Alice' },
            ['id', 'name']
          ));
        }).toThrow('Received UPDATE for non-existent item 1');
      });
      
      it('should accumulate partial updates after INSERT', () => {
        // First INSERT the item (partial data)
        processor.processEvent(createEvent(
          GraphQLRowOperation.Insert,
          { id: 1, name: 'Alice' },
          ['id', 'name']
        ));
        
        // Then UPDATE with additional field
        processor.processEvent(createEvent(
          GraphQLRowOperation.Update,
          { id: 1, age: 30 },
          ['id', 'age']
        ));
        
        // Should merge into complete record
        const stats = processor.getStats();
        expect(stats.totalReceived).toBe(1);
        
        // Not complete yet - we have 3 expected items but only processed 1
        expect(processor.isComplete()).toBe(false);
        
        // Process the other expected items
        processor.processEvent(createEvent(
          GraphQLRowOperation.Insert,
          { id: 2, name: 'Bob', age: 25 },
          ['id', 'name', 'age']
        ));
        
        processor.processEvent(createEvent(
          GraphQLRowOperation.Insert,
          { id: 3, name: 'Charlie', age: 35 },
          ['id', 'name', 'age']
        ));
        
        // NOW it should be complete
        expect(processor.isComplete()).toBe(true);
      });
    });
    
    describe('DELETE operations', () => {
      it('should remove item on DELETE', () => {
        // First INSERT
        processor.processEvent(createEvent(
          GraphQLRowOperation.Insert,
          { id: 1, name: 'Alice', age: 30 },
          ['id', 'name', 'age']
        ));
        
        // Then DELETE
        processor.processEvent(createEvent(
          GraphQLRowOperation.Delete,
          { id: 1 },
          ['id']
        ));
        
        // Item should be removed
        const stats = processor.getStats();
        expect(stats.totalReceived).toBe(0);
      });
      
      it('should handle DELETE for non-existent item', () => {
        // DELETE for item we never saw
        processor.processEvent(createEvent(
          GraphQLRowOperation.Delete,
          { id: 99 },
          ['id']
        ));
        
        // Should not affect state
        const stats = processor.getStats();
        expect(stats.totalReceived).toBe(0);
        expect(processor.isComplete()).toBe(false);
      });
    });
    
    describe('completion detection', () => {
      it('should detect completion when state matches exactly', () => {
        // Insert all expected items
        processor.processEvent(createEvent(
          GraphQLRowOperation.Insert,
          { id: 1, name: 'Alice', age: 30 },
          ['id', 'name', 'age']
        ));
        
        processor.processEvent(createEvent(
          GraphQLRowOperation.Insert,
          { id: 2, name: 'Bob', age: 25 },
          ['id', 'name', 'age']
        ));
        
        expect(processor.isComplete()).toBe(false);
        
        processor.processEvent(createEvent(
          GraphQLRowOperation.Insert,
          { id: 3, name: 'Charlie', age: 35 },
          ['id', 'name', 'age']
        ));
        
        expect(processor.isComplete()).toBe(true);
      });
      
      it('should not be complete with extra items', () => {
        // Insert all expected items
        processor.processEvent(createEvent(
          GraphQLRowOperation.Insert,
          { id: 1, name: 'Alice', age: 30 },
          ['id', 'name', 'age']
        ));
        
        processor.processEvent(createEvent(
          GraphQLRowOperation.Insert,
          { id: 2, name: 'Bob', age: 25 },
          ['id', 'name', 'age']
        ));
        
        processor.processEvent(createEvent(
          GraphQLRowOperation.Insert,
          { id: 3, name: 'Charlie', age: 35 },
          ['id', 'name', 'age']
        ));
        
        // Add unexpected item
        processor.processEvent(createEvent(
          GraphQLRowOperation.Insert,
          { id: 4, name: 'David', age: 40 },
          ['id', 'name', 'age']
        ));
        
        expect(processor.isComplete()).toBe(false); // Has extra item
      });
      
      it('should handle completion through updates', () => {
        // Build up state through partial updates
        processor.processEvent(createEvent(
          GraphQLRowOperation.Insert,
          { id: 1, name: 'Alice' },
          ['id', 'name']
        ));
        
        processor.processEvent(createEvent(
          GraphQLRowOperation.Update,
          { id: 1, age: 30 },
          ['id', 'age']
        ));
        
        processor.processEvent(createEvent(
          GraphQLRowOperation.Insert,
          { id: 2, name: 'Bob', age: 25 },
          ['id', 'name', 'age']
        ));
        
        processor.processEvent(createEvent(
          GraphQLRowOperation.Insert,
          { id: 3, name: 'Charlie', age: 35 },
          ['id', 'name', 'age']
        ));
        
        expect(processor.isComplete()).toBe(true);
      });
    });
    
    describe('edge cases', () => {
      it('should handle null/undefined fields', () => {
        const event = createEvent(
          GraphQLRowOperation.Insert,
          { id: 1, name: 'Alice', age: null },
          ['id', 'name', 'age']
        );
        
        processor.processEvent(event);
        
        const stats = processor.getStats();
        expect(stats.totalReceived).toBe(1);
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
        
        complexProcessor.processEvent(createEvent(
          GraphQLRowOperation.Insert,
          { 
            id: 1, 
            profile: { 
              name: 'Alice',
              settings: { theme: 'dark' }
            }
          },
          ['id', 'profile']
        ));
        
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
      processor.processEvent(createEvent(
        GraphQLRowOperation.Insert,
        { id: 1, name: 'Alice' },
        ['id', 'name']
      ));
      
      expect(processor.isComplete()).toBe(false); // Has unexpected item
    });
  });
});