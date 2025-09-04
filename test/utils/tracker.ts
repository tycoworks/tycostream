export enum State {
  Active = 'active',
  Stalled = 'stalled',
  Completed = 'completed',
  Failed = 'failed'
}

export interface StateTrackerOptions {
  livenessTimeoutMs: number;
  onStalled: () => void;
  onRecovered: () => void;
  onCompleted: () => void;
  onFailed: () => void;
}

/**
 * Tracks the state lifecycle of an event stream handler.
 * Manages transitions between Active, Stalled, and Completed states.
 */
export class StateTracker {
  private state: State = State.Active;
  private livenessTimer?: NodeJS.Timeout;
  private readonly livenessTimeoutMs: number;
  private readonly onStalled: () => void;
  private readonly onRecovered: () => void;
  private readonly onCompleted: () => void;
  private readonly onFailed: () => void;
  
  constructor(options: StateTrackerOptions) {
    this.livenessTimeoutMs = options.livenessTimeoutMs;
    this.onStalled = options.onStalled;
    this.onRecovered = options.onRecovered;
    this.onCompleted = options.onCompleted;
    this.onFailed = options.onFailed;
    
    // Start the liveness timer immediately
    this.resetLivenessTimer();
  }
  
  /**
   * Record activity from the handler, resetting the liveness timer
   */
  recordActivity(): void {
    // Can't record activity if we're in a terminal state
    if (this.state === State.Completed || this.state === State.Failed) return;
    
    // If we were stalled, recover
    if (this.state === State.Stalled) {
      this.state = State.Active;
      this.onRecovered();
    }
    
    this.resetLivenessTimer();
  }
  
  /**
   * Mark the handler as completed
   */
  markCompleted(): void {
    if (this.state === State.Completed || this.state === State.Failed) return;
    
    this.clearLivenessTimer();
    this.state = State.Completed;
    this.onCompleted();
  }
  
  /**
   * Mark the handler as failed
   */
  markFailed(): void {
    if (this.state === State.Completed || this.state === State.Failed) return;
    
    this.clearLivenessTimer();
    this.state = State.Failed;
    this.onFailed();
  }
  
  /**
   * Clean up resources
   */
  dispose(): void {
    this.clearLivenessTimer();
  }
  
  /**
   * Get the current state
   */
  getState(): State {
    return this.state;
  }
  
  private resetLivenessTimer(): void {
    this.clearLivenessTimer();
    
    this.livenessTimer = setTimeout(() => {
      if (this.state === State.Active) {
        this.state = State.Stalled;
        this.onStalled();
      }
    }, this.livenessTimeoutMs);
  }
  
  private clearLivenessTimer(): void {
    if (this.livenessTimer) {
      clearTimeout(this.livenessTimer);
      this.livenessTimer = undefined;
    }
  }
}