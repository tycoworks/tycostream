import { Logger } from '@nestjs/common';

const logger = new Logger('GraphQLFilters');

/**
 * Converts a GraphQL where clause to a JavaScript expression string
 * Supports Hasura-compatible operators for filtering
 */
export function buildFilterExpression(where: any, fieldVar = 'datum'): string {
  if (!where || typeof where !== 'object') {
    return 'true';
  }

  // Handle logical operators
  if (where._and) {
    const expressions = where._and.map((w: any) => buildFilterExpression(w, fieldVar));
    return `(${expressions.join(' && ')})`;
  }
  
  if (where._or) {
    const expressions = where._or.map((w: any) => buildFilterExpression(w, fieldVar));
    return `(${expressions.join(' || ')})`;
  }
  
  if (where._not) {
    return `!(${buildFilterExpression(where._not, fieldVar)})`;
  }

  // Handle field comparisons
  const expressions: string[] = [];
  
  for (const [field, operators] of Object.entries(where)) {
    if (typeof operators !== 'object' || operators === null) {
      continue;
    }
    
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