import { Filter } from './filter';
import { Expression } from './types';

describe('Filter', () => {
  describe('constructor', () => {
    it('should create filter with explicit match and unmatch', () => {
      const match: Expression = {
        evaluate: (row) => row.value > 100,
        fields: new Set(['value']),
        expression: 'value > 100'
      };
      
      const unmatch: Expression = {
        evaluate: (row) => row.value <= 95,
        fields: new Set(['value']),
        expression: 'value <= 95'
      };
      
      const filter = new Filter(match, unmatch);
      
      expect(filter.match).toBe(match);
      expect(filter.unmatch).toBe(unmatch);
      expect(filter.fields).toEqual(new Set(['value']));
    });
    
    it('should normalize unmatch to negation of match when not provided', () => {
      const match: Expression = {
        evaluate: (row) => row.active === true,
        fields: new Set(['active']),
        expression: 'active === true'
      };
      
      const filter = new Filter(match);
      
      expect(filter.match).toBe(match);
      expect(filter.unmatch.expression).toBe('!(active === true)');
      expect(filter.unmatch.fields).toBe(match.fields);
      expect(filter.fields).toEqual(new Set(['active']));
      
      // Test the normalized unmatch function
      expect(filter.unmatch.evaluate({ active: true })).toBe(false);
      expect(filter.unmatch.evaluate({ active: false })).toBe(true);
    });
    
    it('should combine fields from match and unmatch', () => {
      const match: Expression = {
        evaluate: (row) => row.status === 'active',
        fields: new Set(['status']),
        expression: 'status === "active"'
      };
      
      const unmatch: Expression = {
        evaluate: (row) => row.terminated === true,
        fields: new Set(['terminated']),
        expression: 'terminated === true'
      };
      
      const filter = new Filter(match, unmatch);
      
      expect(filter.fields).toEqual(new Set(['status', 'terminated']));
    });
    
    it('should handle overlapping fields between match and unmatch', () => {
      const match: Expression = {
        evaluate: (row) => row.value > 100 && row.active,
        fields: new Set(['value', 'active']),
        expression: 'value > 100 && active'
      };
      
      const unmatch: Expression = {
        evaluate: (row) => row.value < 50 || !row.active,
        fields: new Set(['value', 'active']),
        expression: 'value < 50 || !active'
      };
      
      const filter = new Filter(match, unmatch);
      
      // Should not have duplicates
      expect(filter.fields).toEqual(new Set(['value', 'active']));
      expect(filter.fields.size).toBe(2);
    });
  });
  
  describe('behavior', () => {
    it('should correctly evaluate hysteresis behavior', () => {
      const filter = new Filter(
        {
          evaluate: (row) => row.temp >= 100,
          fields: new Set(['temp']),
          expression: 'temp >= 100'
        },
        {
          evaluate: (row) => row.temp < 95,
          fields: new Set(['temp']),
          expression: 'temp < 95'
        }
      );
      
      // Test match condition
      expect(filter.match.evaluate({ temp: 100 })).toBe(true);
      expect(filter.match.evaluate({ temp: 99 })).toBe(false);
      
      // Test unmatch condition
      expect(filter.unmatch.evaluate({ temp: 94 })).toBe(true);
      expect(filter.unmatch.evaluate({ temp: 95 })).toBe(false);
      
      // Test hysteresis zone (between 95 and 99)
      const inBetween = { temp: 97 };
      expect(filter.match.evaluate(inBetween)).toBe(false);
      expect(filter.unmatch.evaluate(inBetween)).toBe(false);
    });
    
    it('should handle complex expressions', () => {
      const filter = new Filter({
        evaluate: (row) => row.status === 'active' && row.priority > 5,
        fields: new Set(['status', 'priority']),
        expression: 'status === "active" && priority > 5'
      });
      
      expect(filter.match.evaluate({ status: 'active', priority: 6 })).toBe(true);
      expect(filter.match.evaluate({ status: 'active', priority: 5 })).toBe(false);
      expect(filter.match.evaluate({ status: 'inactive', priority: 6 })).toBe(false);
      
      // Normalized unmatch should negate the match
      expect(filter.unmatch.evaluate({ status: 'active', priority: 6 })).toBe(false);
      expect(filter.unmatch.evaluate({ status: 'active', priority: 5 })).toBe(true);
      expect(filter.unmatch.evaluate({ status: 'inactive', priority: 6 })).toBe(true);
    });
  });
});