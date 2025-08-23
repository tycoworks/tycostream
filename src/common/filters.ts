import { Logger } from '@nestjs/common';
import { Filter } from '../streaming/types';

const logger = new Logger('Filters');

/**
 * GraphQL/Hasura-style where clause types
 */
export type WhereClause = {
  _and?: WhereClause[];
  _or?: WhereClause[];
  _not?: WhereClause;
} & {
  [field: string]: FieldComparison | undefined;
};

export type FieldComparison = {
  _eq?: any;
  _neq?: any;
  _gt?: any;
  _lt?: any;
  _gte?: any;
  _lte?: any;
  _in?: any;  // Runtime validates this should be an array
  _nin?: any;  // Runtime validates this should be an array
  _is_null?: boolean;
  [key: string]: any;  // Allow unknown operators for error handling
};

/**
 * Builds a Filter object from a GraphQL where clause
 * This includes the compiled function and metadata for optimization
 * Throws error for empty where clauses
 */
export function buildFilter(where: WhereClause): Filter {
  if (Object.keys(where).length === 0) {
    throw new Error('Cannot build filter from empty where clause');
  }
  
  const fields = new Set<string>();
  const expression = buildExpression(where, 'datum', fields);
  
  try {
    const evaluate = new Function('datum', `return ${expression}`) as (row: any) => boolean;
    
    return {
      evaluate,
      fields,
      expression
    };
  } catch (error) {
    throw new Error(`Failed to compile filter expression: ${error.message}`);
  }
}

/**
 * Internal helper that builds expression string and collects fields
 */
function buildExpression(where: WhereClause, fieldVar: string, fields: Set<string>): string {

  // Handle logical operators
  if (where._and) {
    const expressions = where._and.map(w => buildExpression(w, fieldVar, fields));
    return `(${expressions.join(' && ')})`;
  }
  
  if (where._or) {
    const expressions = where._or.map(w => buildExpression(w, fieldVar, fields));
    return `(${expressions.join(' || ')})`;
  }
  
  if (where._not) {
    return `!(${buildExpression(where._not, fieldVar, fields)})`;
  }

  // Handle field comparisons
  const expressions: string[] = [];
  
  for (const [field, operators] of Object.entries(where)) {
    if (typeof operators !== 'object' || operators === null) {
      continue;
    }
    
    // Track this field
    fields.add(field);
    
    for (const [op, value] of Object.entries(operators)) {
      const fieldAccess = `${fieldVar}.${field}`;
      
      switch (op) {
        case '_eq':
          expressions.push(`${fieldAccess} === ${JSON.stringify(value)}`);
          break;
        case '_neq':
          expressions.push(`${fieldAccess} !== ${JSON.stringify(value)}`);
          break;
        case '_gt':
          expressions.push(`${fieldAccess} > ${JSON.stringify(value)}`);
          break;
        case '_lt':
          expressions.push(`${fieldAccess} < ${JSON.stringify(value)}`);
          break;
        case '_gte':
          expressions.push(`${fieldAccess} >= ${JSON.stringify(value)}`);
          break;
        case '_lte':
          expressions.push(`${fieldAccess} <= ${JSON.stringify(value)}`);
          break;
        case '_in':
          if (!Array.isArray(value)) {
            throw new Error(`_in operator requires an array, got ${typeof value}`);
          }
          expressions.push(`[${value.map(v => JSON.stringify(v)).join(', ')}].indexOf(${fieldAccess}) !== -1`);
          break;
        case '_nin':
          if (!Array.isArray(value)) {
            throw new Error(`_nin operator requires an array, got ${typeof value}`);
          }
          expressions.push(`[${value.map(v => JSON.stringify(v)).join(', ')}].indexOf(${fieldAccess}) === -1`);
          break;
        case '_is_null':
          expressions.push(value ? `${fieldAccess} == null` : `${fieldAccess} != null`);
          break;
        default:
          throw new Error(`Unknown operator: ${op}`);
      }
    }
  }
  
  // When multiple field expressions exist, wrap in parentheses if we're inside an _or
  // to ensure clear operator precedence
  if (expressions.length === 0) {
    return 'true';
  } else if (expressions.length === 1) {
    return expressions[0];
  } else {
    // Multiple expressions - wrap in parentheses for clarity
    return `(${expressions.join(' && ')})`;
  }
}