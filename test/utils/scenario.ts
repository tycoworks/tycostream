export enum OperationType {
  INSERT = 'INSERT',
  UPDATE = 'UPDATE', 
  DELETE = 'DELETE'
}

export interface OperationTemplate {
  type: OperationType;
  id: number;
  fields: Record<string, any>;
}

export class TestScenario {
  private operations: Array<{ sql: string; params: any[] }> = [];
  private numIterations: number;
  private readonly ID_OFFSET = 1000;

  constructor(
    operationSequence: OperationTemplate[],
    numIterations: number
  ) {
    this.numIterations = numIterations;
    
    // Generate all SQL operations
    for (let iteration = 0; iteration < numIterations; iteration++) {
      for (const op of operationSequence) {
        const adjustedId = this.getAdjustedId(op.id, iteration);
        
        // Build the SQL operation
        let sql: string;
        let params: any[];
        
        switch (op.type) {
          case OperationType.INSERT:
            sql = 'INSERT INTO stress_test (id, value, status, department) VALUES ($1, $2, $3, $4)';
            params = [adjustedId, op.fields.value, op.fields.status, op.fields.department];
            break;
            
          case OperationType.UPDATE:
            const updates: string[] = [];
            params = [];
            
            for (const [field, value] of Object.entries(op.fields)) {
              updates.push(`${field} = $${params.length + 1}`);
              params.push(value);
            }
            
            sql = `UPDATE stress_test SET ${updates.join(', ')} WHERE id = $${params.length + 1}`;
            params.push(adjustedId);
            break;
            
          case OperationType.DELETE:
            sql = 'DELETE FROM stress_test WHERE id = $1';
            params = [adjustedId];
            break;
            
          default:
            throw new Error(`Unknown operation type: ${op.type}`);
        }
        
        this.operations.push({ sql, params });
      }
    }
  }
  
  private getAdjustedId(baseId: number, iteration: number): number {
    return baseId + (iteration * this.ID_OFFSET);
  }
  
  /**
   * Get all SQL operations to execute
   */
  getOperations(): Array<{ sql: string; params: any[] }> {
    return this.operations;
  }
  
  /**
   * Get state based on a base state map
   * The base state map contains the expected state for one iteration
   * This expands it to all iterations
   */
  getState(baseStateMap: Map<number, any>): Map<number, any> {
    const expandedState = new Map();
    
    // Expand the base state map for all iterations
    for (let iteration = 0; iteration < this.numIterations; iteration++) {
      baseStateMap.forEach((row, baseId) => {
        const adjustedId = this.getAdjustedId(baseId, iteration);
        expandedState.set(adjustedId, {
          ...row,
          id: adjustedId
        });
      });
    }
    
    return expandedState;
  }
}