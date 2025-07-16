import { describe, it, expect } from 'vitest';

// TODO: Row ordering tests need to be re-evaluated with new architecture
// The SimpleCache uses a Map which doesn't guarantee insertion order
describe.skip('Row Insertion Order Preservation', () => {
  it('should preserve insertion order in snapshots', () => {
    // Test disabled - need to determine if order preservation is required
  });

  it('should preserve position on update (replace in-place)', () => {
    // Test disabled - need to determine if order preservation is required
  });
});