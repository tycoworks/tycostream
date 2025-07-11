// Global test setup to prevent schema files from being created in real config directory
import { rmSync } from 'fs';
import { join } from 'path';

// Clean up any schema files that might have been created in the real config directory
const realConfigDir = join(process.cwd(), 'config');
const realSchemaPath = join(realConfigDir, 'schema.yaml');

// Add cleanup after each test
afterEach(() => {
  try {
    rmSync(realSchemaPath, { force: true });
  } catch {
    // File doesn't exist, that's fine
  }
});

// Add cleanup after all tests
afterAll(() => {
  try {
    rmSync(realSchemaPath, { force: true });
  } catch {
    // File doesn't exist, that's fine
  }
});