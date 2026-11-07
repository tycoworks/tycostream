import { DatabaseModule } from './database.module.js';
import { DatabaseService } from './database.service.js';
import { DatabaseConnectionService } from './connection.service.js';
import { DatabaseDriver } from './types.js';

describe('DatabaseModule', () => {
  it('should be defined', () => {
    expect(DatabaseModule).toBeDefined();
  });

  it('should provide the correct services', () => {
    const providers = Reflect.getMetadata('providers', DatabaseModule);
    const exports = Reflect.getMetadata('exports', DatabaseModule);

    // Check providers includes the services
    const providerTokens = providers.map((p: any) => p.provide || p);
    expect(providerTokens).toContain(DatabaseService);
    expect(providerTokens).toContain(DatabaseConnectionService);
    expect(providerTokens).toContain(DatabaseDriver);

    // Only DatabaseService is exported
    expect(exports).toEqual([DatabaseService]);
  });
});
