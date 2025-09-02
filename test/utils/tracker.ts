/**
 * Generic state tracker for comparing current vs expected state
 * Can be used for both subscriptions (state convergence) and webhooks (event collection)
 */
export class StateTracker<TData> {
  protected currentState = new Map<string | number, TData>();
  protected expectedState: Map<string | number, TData>;
  protected receivedOrder: Array<string | number> = [];
  protected expectedOrder?: Array<string | number>;
  
  constructor(
    expectedState: Map<string | number, TData>,
    expectedOrder?: Array<string | number>
  ) {
    this.expectedState = expectedState;
    this.expectedOrder = expectedOrder;
  }
  
  /**
   * Insert an item into the state
   */
  insert(id: string | number, data: TData): void {
    this.currentState.set(id, data);
    
    // Track order if we're checking it
    if (this.expectedOrder) {
      this.receivedOrder.push(id);
    }
  }
  
  /**
   * Update specific fields of an existing item
   * @param fields Array of field names that were updated
   * @param rowData The data containing the updated fields
   */
  update(id: string | number, fields: string[], rowData: any): void {
    const existing = this.currentState.get(id);
    if (!existing) {
      throw new Error(`UPDATE for non-existent row with id=${id}`);
    }
    
    // Build the updated object with only the specified fields
    const updated = { ...existing };
    for (const field of fields) {
      updated[field as keyof TData] = rowData[field];
    }
    
    this.currentState.set(id, updated);
  }
  
  /**
   * Delete an item from the state
   */
  delete(id: string | number): void {
    this.currentState.delete(id);
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