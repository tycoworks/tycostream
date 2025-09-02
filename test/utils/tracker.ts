/**
 * Generic state tracker for comparing current vs expected state
 * Can be used for both subscriptions (state convergence) and webhooks (event collection)
 */
export class StateTracker<TData> {
  protected currentState = new Map<string | number, TData>();
  protected expectedState: Map<string | number, TData>;
  protected receivedOrder: Array<string | number> = [];
  protected expectedOrder?: Array<string | number>;
  protected eventCount = 0;
  protected lastEventTime = Date.now();
  
  constructor(
    private options: {
      // Expected final state
      expectedState: Map<string | number, TData>;
      
      // Optional: Expected order of IDs (for webhooks)
      expectedOrder?: Array<string | number>;
      
      // Function to extract ID from an item
      extractId: (item: TData) => string | number;
      
      // Function to handle how events update the current state
      handleEvent: (
        currentState: Map<string | number, TData>,
        id: string | number,
        event: any,  // Raw event data
        operation: string
      ) => Map<string | number, TData>;
    }
  ) {
    this.expectedState = options.expectedState;
    this.expectedOrder = options.expectedOrder;
  }
  
  /**
   * Handle an incoming event
   */
  handleEvent(event: any, operation: string = 'INSERT'): void {
    this.eventCount++;
    this.lastEventTime = Date.now();
    
    const id = this.options.extractId(event);
    
    // Apply the handler function to update state
    this.currentState = this.options.handleEvent(this.currentState, id, event, operation);
    
    // Track order if we're checking it
    if (this.expectedOrder) {
      this.receivedOrder.push(id);
    }
  }
  
  /**
   * Check if all expectations have been met
   */
  isComplete(): boolean {
    // Check state matches
    if (!this.statesEqual()) {
      return false;
    }
    
    // Check order matches
    return this.ordersEqual();
  }
  
  /**
   * Get current state
   */
  getCurrentState(): Map<string | number, TData> {
    return new Map(this.currentState);
  }
  
  /**
   * Get statistics
   */
  getStats() {
    return {
      eventCount: this.eventCount,
      lastEventTime: this.lastEventTime,
      totalExpected: this.expectedState.size,
      totalReceived: this.currentState.size,
      isComplete: this.isComplete()
    };
  }
  
  private statesEqual(): boolean {
    if (this.currentState.size !== this.expectedState.size) {
      return false;
    }
    
    for (const [id, expectedData] of this.expectedState) {
      const currentData = this.currentState.get(id);
      if (!currentData || JSON.stringify(currentData) !== JSON.stringify(expectedData)) {
        return false;
      }
    }
    
    return true;
  }
  
  private ordersEqual(): boolean {
    if (!this.expectedOrder) return true;
    
    if (this.receivedOrder.length !== this.expectedOrder.length) {
      return false;
    }
    
    for (let i = 0; i < this.expectedOrder.length; i++) {
      if (this.receivedOrder[i] !== this.expectedOrder[i]) {
        return false;
      }
    }
    
    return true;
  }
}