import { OperationType, OperationTemplate, TestScenario } from './scenario';

describe('TestScenario', () => {
  describe('getOperations', () => {
    it('should generate correct operations for single iteration', () => {
      const operations: OperationTemplate[] = [
        { type: OperationType.INSERT, id: 1, fields: { value: 100, status: 'active' } },
        { type: OperationType.UPDATE, id: 1, fields: { value: 200 } },
        { type: OperationType.DELETE, id: 1, fields: {} }
      ];

      const scenario = new TestScenario(operations, 1);
      const result = scenario.getOperations();

      const expected = [
        { sql: 'INSERT INTO stress_test (id, value, status, department) VALUES ($1, $2, $3, $4)', params: [1, 100, 'active', undefined] },
        { sql: 'UPDATE stress_test SET value = $1 WHERE id = $2', params: [200, 1] },
        { sql: 'DELETE FROM stress_test WHERE id = $1', params: [1] }
      ];

      expect(result).toEqual(expected);
    });

    it('should generate correct operations for multiple iterations', () => {
      const operations: OperationTemplate[] = [
        { type: OperationType.INSERT, id: 1, fields: { value: 100, status: 'active' } },
        { type: OperationType.INSERT, id: 2, fields: { value: 200, status: 'pending' } }
      ];

      const scenario = new TestScenario(operations, 2);
      const result = scenario.getOperations();

      const expected = [
        // First iteration
        { sql: 'INSERT INTO stress_test (id, value, status, department) VALUES ($1, $2, $3, $4)', params: [1, 100, 'active', undefined] },
        { sql: 'INSERT INTO stress_test (id, value, status, department) VALUES ($1, $2, $3, $4)', params: [2, 200, 'pending', undefined] },
        // Second iteration with ID offset
        { sql: 'INSERT INTO stress_test (id, value, status, department) VALUES ($1, $2, $3, $4)', params: [1001, 100, 'active', undefined] },
        { sql: 'INSERT INTO stress_test (id, value, status, department) VALUES ($1, $2, $3, $4)', params: [1002, 200, 'pending', undefined] }
      ];

      expect(result).toEqual(expected);
    });

    it('should handle complex UPDATE operations', () => {
      const operations: OperationTemplate[] = [
        { type: OperationType.UPDATE, id: 5, fields: { value: 300, status: 'active', department: 'eng' } }
      ];

      const scenario = new TestScenario(operations, 1);
      const result = scenario.getOperations();

      const expected = [
        { sql: 'UPDATE stress_test SET value = $1, status = $2, department = $3 WHERE id = $4', params: [300, 'active', 'eng', 5] }
      ];

      expect(result).toEqual(expected);
    });
  });

  describe('getTriggerEvents', () => {
    it('should expand trigger events for single iteration', () => {
      const baseTriggerEvents = [
        { event_type: 'MATCH', trigger_name: 'test_trigger', data: { id: 1, value: 100, status: 'active' }},
        { event_type: 'UNMATCH', trigger_name: 'test_trigger', data: { id: 2, value: 200, status: 'inactive' }}
      ];

      const scenario = new TestScenario([], 1);
      const result = scenario.getTriggerEvents(baseTriggerEvents);

      expect(result).toEqual([
        { event_type: 'MATCH', trigger_name: 'test_trigger', data: { id: 1, value: 100, status: 'active' }},
        { event_type: 'UNMATCH', trigger_name: 'test_trigger', data: { id: 2, value: 200, status: 'inactive' }}
      ]);
    });

    it('should expand trigger events with ID offsets for multiple iterations', () => {
      const baseTriggerEvents = [
        { event_type: 'MATCH', trigger_name: 'test_trigger', data: { id: 1, value: 100 }},
        { event_type: 'MATCH', trigger_name: 'test_trigger', data: { id: 2, value: 200 }}
      ];

      const scenario = new TestScenario([], 3);
      const result = scenario.getTriggerEvents(baseTriggerEvents);

      expect(result).toEqual([
        // First iteration
        { event_type: 'MATCH', trigger_name: 'test_trigger', data: { id: 1, value: 100 }},
        { event_type: 'MATCH', trigger_name: 'test_trigger', data: { id: 2, value: 200 }},
        // Second iteration
        { event_type: 'MATCH', trigger_name: 'test_trigger', data: { id: 1001, value: 100 }},
        { event_type: 'MATCH', trigger_name: 'test_trigger', data: { id: 1002, value: 200 }},
        // Third iteration
        { event_type: 'MATCH', trigger_name: 'test_trigger', data: { id: 2001, value: 100 }},
        { event_type: 'MATCH', trigger_name: 'test_trigger', data: { id: 2002, value: 200 }}
      ]);
    });

    it('should handle empty trigger events array', () => {
      const baseTriggerEvents: any[] = [];

      const scenario = new TestScenario([], 5);
      const result = scenario.getTriggerEvents(baseTriggerEvents);

      expect(result).toEqual([]);
    });

    it('should preserve all fields in trigger event data', () => {
      const baseTriggerEvents = [
        { 
          event_type: 'MATCH', 
          trigger_name: 'complex_trigger', 
          data: { 
            id: 10, 
            value: 500, 
            status: 'active', 
            extra: 'data', 
            nested: { foo: 'bar' } 
          }
        }
      ];

      const scenario = new TestScenario([], 2);
      const result = scenario.getTriggerEvents(baseTriggerEvents);

      expect(result[0]).toEqual({
        event_type: 'MATCH',
        trigger_name: 'complex_trigger',
        data: {
          id: 10,
          value: 500,
          status: 'active',
          extra: 'data',
          nested: { foo: 'bar' }
        }
      });

      expect(result[1]).toEqual({
        event_type: 'MATCH',
        trigger_name: 'complex_trigger',
        data: {
          id: 1010,
          value: 500,
          status: 'active',
          extra: 'data',
          nested: { foo: 'bar' }
        }
      });
    });

    it('should maintain event order across iterations', () => {
      const baseTriggerEvents = [
        { event_type: 'MATCH', trigger_name: 'trigger', data: { id: 1, sequence: 'first' }},
        { event_type: 'UNMATCH', trigger_name: 'trigger', data: { id: 1, sequence: 'second' }},
        { event_type: 'MATCH', trigger_name: 'trigger', data: { id: 2, sequence: 'third' }}
      ];

      const scenario = new TestScenario([], 2);
      const result = scenario.getTriggerEvents(baseTriggerEvents);

      // Check order is maintained: all events from iteration 1, then all from iteration 2
      expect(result.map(e => e.data.sequence)).toEqual([
        'first', 'second', 'third',  // iteration 1
        'first', 'second', 'third'   // iteration 2
      ]);
    });
  });

  describe('getSubscriptionState', () => {
    it('should expand base state for single iteration', () => {
      const baseState = new Map([
        [1, { id: 1, value: 100, status: 'active' }],
        [2, { id: 2, value: 200, status: 'pending' }]
      ]);

      const scenario = new TestScenario([], 1);
      const result = scenario.getSubscriptionState(baseState);

      expect(result.size).toBe(2);
      expect(result.get(1)).toEqual({ id: 1, value: 100, status: 'active' });
      expect(result.get(2)).toEqual({ id: 2, value: 200, status: 'pending' });
    });

    it('should expand base state with ID offsets for multiple iterations', () => {
      const baseState = new Map([
        [1, { id: 1, value: 100, status: 'active' }],
        [2, { id: 2, value: 200, status: 'pending' }]
      ]);

      const scenario = new TestScenario([], 3);
      const result = scenario.getSubscriptionState(baseState);

      expect(result.size).toBe(6); // 2 entries * 3 iterations

      // First iteration
      expect(result.get(1)).toEqual({ id: 1, value: 100, status: 'active' });
      expect(result.get(2)).toEqual({ id: 2, value: 200, status: 'pending' });
      
      // Second iteration
      expect(result.get(1001)).toEqual({ id: 1001, value: 100, status: 'active' });
      expect(result.get(1002)).toEqual({ id: 1002, value: 200, status: 'pending' });
      
      // Third iteration
      expect(result.get(2001)).toEqual({ id: 2001, value: 100, status: 'active' });
      expect(result.get(2002)).toEqual({ id: 2002, value: 200, status: 'pending' });
    });

    it('should handle empty base state', () => {
      const baseState = new Map();

      const scenario = new TestScenario([], 5);
      const result = scenario.getSubscriptionState(baseState);

      expect(result.size).toBe(0);
    });

    it('should preserve all fields from base state', () => {
      const baseState = new Map([
        [10, { id: 10, value: 500, status: 'active', extra: 'data', nested: { foo: 'bar' } }]
      ]);

      const scenario = new TestScenario([], 2);
      const result = scenario.getSubscriptionState(baseState);

      expect(result.get(10)).toEqual({
        id: 10,
        value: 500,
        status: 'active',
        extra: 'data',
        nested: { foo: 'bar' }
      });

      expect(result.get(1010)).toEqual({
        id: 1010,
        value: 500,
        status: 'active',
        extra: 'data',
        nested: { foo: 'bar' }
      });
    });
  });

});