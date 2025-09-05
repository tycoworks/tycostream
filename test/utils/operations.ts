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

export class TestOperations {
  /**
   * Build SQL operation from template with optional ID offset for iterations
   */
  static buildOperation(op: OperationTemplate, idOffset: number = 0): { sql: string; params: any[] } {
    let sql: string;
    let params: any[];
    
    switch (op.type) {
      case OperationType.INSERT:
        sql = 'INSERT INTO stress_test (id, value, status, department) VALUES ($1, $2, $3, $4)';
        params = [op.id + idOffset, op.fields.value, op.fields.status, op.fields.department];
        break;
        
      case OperationType.UPDATE:
        // Build UPDATE dynamically based on which fields are present
        const updates: string[] = [];
        params = [];
        
        for (const [field, value] of Object.entries(op.fields)) {
          updates.push(`${field} = $${params.length + 1}`);
          params.push(value);
        }
        
        sql = `UPDATE stress_test SET ${updates.join(', ')} WHERE id = $${params.length + 1}`;
        params.push(op.id + idOffset);
        break;
        
      case OperationType.DELETE:
        sql = 'DELETE FROM stress_test WHERE id = $1';
        params = [op.id + idOffset];
        break;
        
      default:
        throw new Error(`Unknown operation type: ${op.type}`);
    }
    
    return { sql, params };
  }
}