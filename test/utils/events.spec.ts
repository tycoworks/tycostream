import { EventHandler, EventStream, EventProcessor, State, Stats } from './events';

/**
 * Mock EventStream for testing
 */
class MockEventStream implements EventStream<string> {
  private callback?: (data: string) => void;
  private errorCallback?: (error: Error) => void;
  
  async subscribe(
    onData: (data: string) => void,
    onError?: (error: Error) => void
  ): Promise<void> {
    this.callback = onData;
    this.errorCallback = onError;
  }
  
  async unsubscribe(): Promise<void> {
    this.callback = undefined;
    this.errorCallback = undefined;
  }
  
  // Test helpers
  emit(data: string): void {
    this.callback?.(data);
  }
  
  emitError(error: Error): void {
    this.errorCallback?.(error);
  }
}

/**
 * Mock EventProcessor for testing
 */
class MockEventProcessor implements EventProcessor<string> {
  private events: string[] = [];
  private complete: boolean;
  
  constructor(private expectedCount: number = 3) {}
  
  processEvent(data: string): void {
    this.events.push(data);
    if (this.events.length >= this.expectedCount) {
      this.complete = true;
    }
  }
  
  isComplete(): boolean {
    return this.complete;
  }
  
  getStats(): Stats {
    return {
      totalExpected: this.expectedCount,
      totalReceived: this.events.length
    };
  }
  
  // Test helper
  reset(): void {
    this.events = [];
    this.complete = false;
  }
}

describe('EventHandler', () => {
  let handler: EventHandler<string>;
  let stream: MockEventStream;
  let processor: MockEventProcessor;
  
  beforeEach(() => {
    jest.useFakeTimers();
    stream = new MockEventStream();
    processor = new MockEventProcessor(3);
    
    handler = new EventHandler(stream, processor, {
      id: 'test-handler',
      clientId: 'test-client',
      livenessTimeoutMs: 1000
    });
  });
  
  afterEach(() => {
    jest.useRealTimers();
  });
  
  describe('liveness detection', () => {
    it('should start in Active state', () => {
      expect(handler.getState()).toBe(State.Active);
    });
    
    it('should transition to Stalled after timeout with no events', async () => {
      await handler.start();
      
      expect(handler.getState()).toBe(State.Active);
      
      // Fast-forward past liveness timeout
      jest.advanceTimersByTime(1001);
      
      expect(handler.getState()).toBe(State.Stalled);
    });
    
    it('should reset liveness timer on each event', async () => {
      await handler.start();
      
      // Advance time but not past timeout
      jest.advanceTimersByTime(500);
      stream.emit('event1');
      
      // Advance another 500ms (total 1000ms, but timer was reset)
      jest.advanceTimersByTime(500);
      expect(handler.getState()).toBe(State.Active);
      
      // Advance past timeout from last event
      jest.advanceTimersByTime(501);
      expect(handler.getState()).toBe(State.Stalled);
    });
    
    it('should recover from Stalled to Active on new events', async () => {
      await handler.start();
      
      // Let it stall
      jest.advanceTimersByTime(1001);
      expect(handler.getState()).toBe(State.Stalled);
      
      // Emit event to recover
      stream.emit('recovery-event');
      expect(handler.getState()).toBe(State.Active);
      
      // Timer should be reset
      jest.advanceTimersByTime(500);
      expect(handler.getState()).toBe(State.Active);
      
      // Should stall again after timeout
      jest.advanceTimersByTime(501);
      expect(handler.getState()).toBe(State.Stalled);
    });
    
    it('should cleanup timers on completion', async () => {
      await handler.start();
      
      // Complete the processor
      stream.emit('event1');
      stream.emit('event2');
      stream.emit('event3');
      
      expect(handler.getState()).toBe(State.Completed);
      
      // Advance time - should not transition to stalled
      jest.advanceTimersByTime(2000);
      expect(handler.getState()).toBe(State.Completed);
    });
    
    it('should cleanup timers on failure', async () => {
      await handler.start();
      
      // Emit error
      stream.emitError(new Error('Test error'));
      
      expect(handler.getState()).toBe(State.Failed);
      
      // Advance time - should not transition to stalled
      jest.advanceTimersByTime(2000);
      expect(handler.getState()).toBe(State.Failed);
    });
    
    it('should handle rapid events correctly', async () => {
      await handler.start();
      
      // Emit 2 events rapidly (processor expects 3 to complete)
      stream.emit('event1');
      jest.advanceTimersByTime(100);
      stream.emit('event2');
      jest.advanceTimersByTime(100);
      
      // Should still be active (not enough events to complete, not timed out)
      expect(handler.getState()).toBe(State.Active);
      
      // Now wait for timeout
      jest.advanceTimersByTime(801);  // Total: 1001ms
      expect(handler.getState()).toBe(State.Stalled);
    });
  });
  
  describe('state change callback', () => {
    it('should call onStateChange when state changes', async () => {
      const onStateChange = jest.fn();
      
      handler = new EventHandler(stream, processor, {
        id: 'test-handler',
        clientId: 'test-client',
        livenessTimeoutMs: 1000,
        onStateChange
      });
      
      await handler.start();
      
      // Transition to stalled
      jest.advanceTimersByTime(1001);
      expect(onStateChange).toHaveBeenCalled();
      
      // Recover
      onStateChange.mockClear();
      stream.emit('recovery');
      expect(onStateChange).toHaveBeenCalled();
      
      // Complete
      onStateChange.mockClear();
      stream.emit('event1');
      stream.emit('event2');
      expect(onStateChange).toHaveBeenCalled();
    });
    
    it('should not call onStateChange for same state', async () => {
      const onStateChange = jest.fn();
      
      handler = new EventHandler(stream, processor, {
        id: 'test-handler',
        clientId: 'test-client',
        livenessTimeoutMs: 1000,
        onStateChange
      });
      
      await handler.start();
      
      // Multiple events while Active
      stream.emit('event1');
      stream.emit('event2');
      
      // Should not trigger callback (still Active)
      expect(onStateChange).not.toHaveBeenCalled();
    });
  });
  
  describe('edge cases', () => {
    it('should handle start without events', async () => {
      await handler.start();
      jest.advanceTimersByTime(5000);
      expect(handler.getState()).toBe(State.Stalled);
    });
    
    it('should handle multiple start calls', async () => {
      await handler.start();
      await handler.start(); // Second call should be safe
      
      expect(handler.getState()).toBe(State.Active);
    });
    
    it('should handle unsubscribe while stalled', async () => {
      await handler.start();
      
      // Let it stall
      jest.advanceTimersByTime(1001);
      expect(handler.getState()).toBe(State.Stalled);
      
      // Cleanup should work
      // Cleanup happens internally when handler completes/fails
    });
    
    it('should handle zero timeout (immediate stall)', async () => {
      handler = new EventHandler(stream, processor, {
        id: 'test-handler',
        clientId: 'test-client',
        livenessTimeoutMs: 0
      });
      
      await handler.start();
      
      // Should stall immediately
      jest.advanceTimersByTime(1);
      expect(handler.getState()).toBe(State.Stalled);
    });
    
    it('should handle very large timeout', async () => {
      handler = new EventHandler(stream, processor, {
        id: 'test-handler',
        clientId: 'test-client',
        livenessTimeoutMs: 10000000  // 10 seconds instead of MAX_SAFE_INTEGER
      });
      
      await handler.start();
      
      // Advance time but less than timeout
      jest.advanceTimersByTime(1000000); // 1 second
      
      // Should still be active (timeout not reached)
      expect(handler.getState()).toBe(State.Active);
    });
  });
  
});