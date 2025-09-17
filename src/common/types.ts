/**
 * Our internal type system for field types
 * This maintains semantic information needed across layers
 * without being tied to any specific layer's type system
 */

/**
 * Internal data types that maintain semantic distinctions
 * These preserve the fidelity needed for correct type mapping
 */
export enum DataType {
  // Numeric types
  Integer,
  Float,
  BigInt,  // Special handling - stored as string to preserve precision

  // String types
  String,
  UUID,

  // Temporal types
  Timestamp,
  Date,
  Time,

  // Other types
  Boolean,
  JSON,      // JSON/JSONB data
  Array,     // Array types
}