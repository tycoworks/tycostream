import { Trigger } from './trigger';
import { Subject } from 'rxjs';
import { RowUpdateEvent, RowUpdateType, Expression } from '../streaming/types';
import type { Source } from '../streaming/source';

describe('Trigger', () => {
  let trigger: Trigger;
  let mockSource: jest.Mocked<Source>;
  let eventsSubject: Subject<RowUpdateEvent>;
  
  const match: Expression = {
    expression: 'value > 100',
    fields: new Set(['value']),
    evaluate: (row) => row.value > 100
  };
  
  beforeEach(() => {
    // Create a subject to simulate source events
    eventsSubject = new Subject<RowUpdateEvent>();
    
    // Mock source
    mockSource = {
      getPrimaryKeyField: jest.fn(() => 'id'),
      getUpdates: jest.fn(() => eventsSubject.asObservable()),
      dispose: jest.fn(),
      isDisposed: false
    } as any;
  });
  
  afterEach(() => {
    if (trigger) {
      trigger.dispose();
    }
    eventsSubject.complete();
    jest.restoreAllMocks();
  });
  
  describe('construction', () => {
    it('should create trigger with required fields', () => {
      trigger = new Trigger(
        mockSource,
        'test_trigger',
        'https://webhook.url',
        match
      );
      
      expect(trigger.name).toBe('test_trigger');
      expect(trigger.webhook).toBe('https://webhook.url');
      expect(trigger.match).toBe(match);
      expect(trigger.unmatch).toBeUndefined();
      expect(trigger.createdAt).toBeInstanceOf(Date);
    });
    
    it('should create trigger with explicit unmatch', () => {
      const unmatch: Expression = {
        expression: 'value <= 90',
        fields: new Set(['value']),
        evaluate: (row) => row.value <= 90
      };
      
      trigger = new Trigger(
        mockSource,
        'test_trigger',
        'https://webhook.url',
        match,
        unmatch
      );
      
      expect(trigger.unmatch).toBe(unmatch);
    });
    
    it('should subscribe to source updates with skipSnapshot=true', () => {
      trigger = new Trigger(
        mockSource,
        'test_trigger',
        'https://webhook.url',
        match
      );
      
      expect(mockSource.getUpdates).toHaveBeenCalledWith(true);
    });
  });
  
  describe('dispose', () => {
    it('should unsubscribe from source when disposed', () => {
      trigger = new Trigger(
        mockSource,
        'test_trigger',
        'https://webhook.url',
        match
      );
      
      const subscriptionSpy = jest.spyOn(trigger['subscription'], 'unsubscribe');
      
      trigger.dispose();
      
      expect(subscriptionSpy).toHaveBeenCalled();
    });
  });
});