import { DatabaseModule } from './database.module';
import { DatabaseStreamService } from './connection.service';

describe('DatabaseModule', () => {
  it('should be defined', () => {
    expect(DatabaseModule).toBeDefined();
  });

  it('should provide the correct services', () => {
    const providers = Reflect.getMetadata('providers', DatabaseModule);
    const exports = Reflect.getMetadata('exports', DatabaseModule);
    
    // Check providers includes the services
    const providerTokens = providers.map((p: any) => p.provide || p);
    expect(providerTokens).toContain(DatabaseStreamService);
    
    // Check exports includes DatabaseStreamService
    expect(exports).toContain(DatabaseStreamService);
  });
});