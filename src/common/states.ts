import { RowUpdateEvent, RowUpdateType, Expression } from '../streaming/types';

/**
 * State transitions for rows based on match/unmatch conditions
 */
export enum StateTransition {
  Match,      // Row entering matched state
  Unmatch,    // Row leaving matched state  
  Matched,    // Row still matched
  Unmatched   // Row still unmatched
}

/**
 * Tracks state transitions for rows based on match/unmatch conditions
 * Used by both View and Trigger to detect when rows enter/leave matched state
 */
export class StateTracker {
  private readonly matchedKeys = new Set<string | number>();
  private readonly allFields: Set<string>;
  private readonly unmatch: Expression;
  
  constructor(
    private readonly primaryKeyField: string,
    private readonly match: Expression,
    unmatch?: Expression
  ) {
    // If unmatch not provided, use negation of match
    this.unmatch = unmatch || {
      evaluate: (row: any) => !match.evaluate(row),
      fields: match.fields,
      expression: `!(${match.expression})`
    };
    
    // Combine fields for optimization
    this.allFields = new Set([...match.fields, ...this.unmatch.fields]);
  }
  
  /**
   * Process an event and return the state transition
   */
  processEvent(event: RowUpdateEvent): StateTransition {
    const key = event.row[this.primaryKeyField];
    const wasMatched = this.matchedKeys.has(key);
    
    let isMatched: boolean;
    let transition: StateTransition;
    
    if (event.type === RowUpdateType.Delete) {
      isMatched = false;
      transition = wasMatched ? StateTransition.Unmatch : StateTransition.Unmatched;
    } else {
      // INSERT/UPDATE events
      isMatched = this.shouldMatch(event, wasMatched);
      
      if (!wasMatched && isMatched) {
        transition = StateTransition.Match;
      } else if (wasMatched && !isMatched) {
        transition = StateTransition.Unmatch;
      } else if (wasMatched && isMatched) {
        transition = StateTransition.Matched;
      } else {
        transition = StateTransition.Unmatched;
      }
    }
    
    // Update matched keys based on new state
    if (isMatched) {
      this.matchedKeys.add(key);
    } else {
      this.matchedKeys.delete(key);
    }
    
    return transition;
  }
  
  /**
   * Determine if a row should match based on conditions
   */
  private shouldMatch(event: RowUpdateEvent, wasMatched: boolean): boolean {
    const fullRow = event.row;
    
    // Optimization: For UPDATE events where filter fields haven't changed
    if (event.type === RowUpdateType.Update && wasMatched) {
      const hasRelevantChanges = Array.from(event.fields).some(field => this.allFields.has(field));
      if (!hasRelevantChanges) {
        return wasMatched; // Filter result can't have changed
      }
    }
    
    try {
      // Use appropriate condition based on whether row was matched
      const shouldStay = wasMatched 
        ? !this.unmatch.evaluate(fullRow)  // Stay if unmatch is false
        : this.match.evaluate(fullRow);     // Enter if match is true
      
      return shouldStay;
    } catch (error) {
      // On error, exclude the row from match
      return false;
    }
  }
  
  /**
   * Clean up resources
   */
  dispose(): void {
    this.matchedKeys.clear();
  }
}