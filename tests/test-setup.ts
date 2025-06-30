// Global test setup to prevent schema.sdl files from being created in real config directory
import { rmSync } from 'fs';
import { join } from 'path';

// Clean up any schema.sdl files that might have been created in the real config directory
const realConfigDir = join(process.cwd(), 'config');
const realSchemaPath = join(realConfigDir, 'schema.sdl');

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