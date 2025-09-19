import { Logger } from '@nestjs/common';
import { Expression } from '../view/types';
import type { SourceDefinition } from '../config/source.types';

/**
 * GraphQL/Hasura-style expression tree for filtering
 */
export type ExpressionTree = {
  _and?: ExpressionTree[];
  _or?: ExpressionTree[];
  _not?: ExpressionTree;
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
 * Builder class for creating expressions with source-aware enum optimization
 */
export class ExpressionBuilder {
  private static readonly logger = new Logger('ExpressionBuilder');

  constructor(private readonly sourceDefinition: SourceDefinition) {}

  /**
   * Builds an Expression object from an expression tree with enum optimization
   */
  buildExpression(tree: ExpressionTree): Expression {
    if (Object.keys(tree).length === 0) {
      throw new Error('Cannot build expression from empty expression tree');
    }

    const fields = new Set<string>();
    const expression = this.buildExpressionString(tree, 'datum', fields);

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
   * Optimizes enum comparisons when source definition is provided
   */
  private buildExpressionString(tree: ExpressionTree, fieldVar: string, fields: Set<string>): string {
    // Handle logical operators
    if (tree._and) {
      const expressions = tree._and.map(t => this.buildExpressionString(t, fieldVar, fields));
      return `(${expressions.join(' && ')})`;
    }

    if (tree._or) {
      const expressions = tree._or.map(t => this.buildExpressionString(t, fieldVar, fields));
      return `(${expressions.join(' || ')})`;
    }

    if (tree._not) {
      return `!(${this.buildExpressionString(tree._not, fieldVar, fields)})`;
    }

    // Handle field comparisons
    const expressions: string[] = [];

    for (const [field, operators] of Object.entries(tree)) {
      if (typeof operators !== 'object' || operators === null) {
        continue;
      }

      // Track this field
      fields.add(field);

      // Check if this field is an enum
      const fieldDef = this.sourceDefinition.fields.find(f => f.name === field);
      const enumType = fieldDef?.enumType;

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
            expressions.push(this.buildOrdinalComparison(fieldAccess, op, value, enumType?.values));
            break;
          case '_lt':
            expressions.push(this.buildOrdinalComparison(fieldAccess, op, value, enumType?.values));
            break;
          case '_gte':
            expressions.push(this.buildOrdinalComparison(fieldAccess, op, value, enumType?.values));
            break;
          case '_lte':
            expressions.push(this.buildOrdinalComparison(fieldAccess, op, value, enumType?.values));
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

  /**
   * Build an optimized ordinal comparison expression
   * For enums, generates a ternary chain to convert enum values to indices for comparison
   * For non-enums, generates standard comparison
   *
   * For example, with enum ['pending', 'processing', 'shipped'] and _gt: 'pending':
   * We generate fast ternary chain:
   *   (datum.status === 'pending' ? 0 : datum.status === 'processing' ? 1 : datum.status === 'shipped' ? 2 : -1) > 0
   */
  private buildOrdinalComparison(fieldAccess: string, op: string, value: any, enumValues?: string[]): string {
    let leftExpr: string;
    let rightExpr: string;

    if (enumValues) {
      // For enums, convert to indices for comparison
      const valueIndex = enumValues.indexOf(value);
      if (valueIndex === -1) {
        // Invalid enum value - will always be false
        ExpressionBuilder.logger.warn(`Invalid enum value '${value}' in comparison`);
        return 'false';
      }

      // Generate a ternary chain to convert field value to index
      const ternaryChain = enumValues
        .map((v, i) => `${fieldAccess} === ${JSON.stringify(v)} ? ${i}`)
        .join(' : ') + ' : -1';

      leftExpr = `(${ternaryChain})`;
      rightExpr = String(valueIndex);
    } else {
      // For non-enums, use field and value directly
      leftExpr = fieldAccess;
      rightExpr = JSON.stringify(value);
    }

    // Generate the comparison using the appropriate operator
    switch (op) {
      case '_gt':
        return `${leftExpr} > ${rightExpr}`;
      case '_gte':
        return `${leftExpr} >= ${rightExpr}`;
      case '_lt':
        return `${leftExpr} < ${rightExpr}`;
      case '_lte':
        return `${leftExpr} <= ${rightExpr}`;
      default:
        throw new Error(`Unexpected operator for comparison: ${op}`);
    }
  }
}