/**
 * State lifecycle for components
 */
export enum State {
  Active = 'active',
  Stalled = 'stalled',
  Completed = 'completed',
  Failed = 'failed'
}

/**
 * Interface for items that have state
 */
export interface StatefulItem {
  getState(): State;
}

/**
 * Manages state for a component that tracks multiple children
 * Handles state transitions, completion promises, and parent notifications
 */
export class StateManager<T extends StatefulItem> {
  private items = new Map<string, T>();
  private currentState: State = State.Active;
  private completionPromise: Promise<void>;
  private completePromise!: () => void;
  private failPromise!: (error: Error) => void;
  private parent?: StateManager<any>;
  
  constructor(
    private name: string,  // For logging (e.g., "Client xyz" or "Manager")
    private failOnStall: boolean = false  // Whether to fail the promise when stalled
  ) {
    // Create the completion promise
    this.completionPromise = new Promise((resolve, reject) => {
      this.completePromise = resolve;
      this.failPromise = reject;
    });
  }
  
  /**
   * Set the parent state manager for hierarchical state management
   */
  setParent(parent: StateManager<any>): void {
    this.parent = parent;
  }
  
  /**
   * Add an item to track
   */
  add(id: string, item: T): void {
    if (this.items.has(id)) {
      throw new Error(`Item with id '${id}' already exists in ${this.name}`);
    }
    this.items.set(id, item);
  }
  
  /**
   * Remove an item from tracking
   */
  remove(id: string): void {
    this.items.delete(id);
  }
  
  /**
   * Get all tracked items
   */
  getItems(): Map<string, T> {
    return new Map(this.items);
  }
  
  /**
   * Check if an item exists
   */
  has(id: string): boolean {
    return this.items.has(id);
  }
  
  /**
   * Get current state
   */
  getState(): State {
    return this.currentState;
  }
  
  /**
   * Get the completion promise
   */
  waitForCompletion(): Promise<void> {
    return this.completionPromise;
  }
  
  /**
   * Call this when any child's state changes
   * Recomputes aggregate state and handles any transitions
   */
  handleChildStateChange(): void {
    const newState = this.computeAggregateState();
    if (newState !== this.currentState) {
      const oldState = this.currentState;
      this.currentState = newState;
      this.handleStateTransition(oldState, newState);
    }
  }
  
  /**
   * Compute aggregate state from all items
   */
  private computeAggregateState(): State {
    if (this.items.size === 0) return State.Active;
    
    const states = Array.from(this.items.values()).map(item => item.getState());
    
    // Any failure means aggregate failure
    if (states.some(s => s === State.Failed)) return State.Failed;
    
    // All completed means aggregate completed  
    if (states.every(s => s === State.Completed)) return State.Completed;
    
    // All stalled means aggregate stalled
    if (states.every(s => s === State.Stalled)) return State.Stalled;
    
    // Otherwise active
    return State.Active;
  }
  
  /**
   * Handle state transitions
   */
  private handleStateTransition(from: State, to: State): void {
    switch (to) {
      case State.Stalled:
        console.log(`${this.name} stalled - all children stopped`);
        if (this.failOnStall) {
          this.failPromise(new Error(`${this.name} stalled - no data flowing`));
        }
        break;
        
      case State.Completed:
        console.log(`${this.name} completed`);
        this.completePromise();
        break;
        
      case State.Failed:
        console.error(`${this.name} failed`);
        this.failPromise(new Error(`${this.name} failed`));
        break;
        
      case State.Active:
        if (from === State.Stalled) {
          console.log(`${this.name} recovered - at least one child active again`);
        }
        break;
    }
    
    // Notify parent if we have one
    this.parent?.handleChildStateChange();
  }
}