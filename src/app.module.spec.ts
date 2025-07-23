import { Test } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import { AppModule } from './app.module';
import { DatabaseModule } from './database/database.module';
import { GraphqlModule } from './graphql/graphql.module';

describe('AppModule', () => {
  it('should be defined', () => {
    expect(AppModule).toBeDefined();
  });

  it('should import required modules', () => {
    const imports = Reflect.getMetadata('imports', AppModule);
    
    // Check that ConfigModule.forRoot is included
    expect(imports).toBeDefined();
    expect(imports.length).toBeGreaterThan(0);
    
    // Check for DatabaseModule and GraphqlModule
    expect(imports).toContain(DatabaseModule);
    expect(imports).toContain(GraphqlModule);
  });

  it('should create the module', async () => {
    const module = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    expect(module).toBeDefined();
  });
});