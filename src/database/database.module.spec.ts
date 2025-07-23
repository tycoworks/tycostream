import { DatabaseModule } from './database.module';
import { DatabaseConnectionService } from './database-connection.service';
import { DatabaseStreamingManagerService } from './database-streaming-manager.service';

describe('DatabaseModule', () => {
  it('should be defined', () => {
    expect(DatabaseModule).toBeDefined();
  });

  it('should provide the correct services', () => {
    const providers = Reflect.getMetadata('providers', DatabaseModule);
    const exports = Reflect.getMetadata('exports', DatabaseModule);
    
    // Check providers includes the services
    const providerTokens = providers.map((p: any) => p.provide || p);
    expect(providerTokens).toContain(DatabaseConnectionService);
    expect(providerTokens).toContain(DatabaseStreamingManagerService);
    
    // Check exports includes DatabaseStreamingManagerService
    expect(exports).toContain(DatabaseStreamingManagerService);
  });
});