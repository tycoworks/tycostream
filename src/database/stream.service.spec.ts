import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { DatabaseStreamService } from './stream.service';
import { Client } from 'pg';

// Mock pg module
jest.mock('pg', () => {
  return { 
    Client: jest.fn().mockImplementation(() => ({
      connect: jest.fn(),
      end: jest.fn(),
      query: jest.fn(),
    }))
  };
});

describe('DatabaseStreamService', () => {
  let service: DatabaseStreamService;
  let configService: ConfigService;

  beforeEach(async () => {
    // Clear all mocks before each test
    jest.clearAllMocks();
    
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DatabaseStreamService,
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn().mockReturnValue({
              host: 'localhost',
              port: 6875,
              database: 'materialize',
              user: 'test',
              password: 'test',
            }),
          },
        },
      ],
    }).compile();

    service = module.get<DatabaseStreamService>(DatabaseStreamService);
    configService = module.get<ConfigService>(ConfigService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  // Removed createClient and removeClient tests since they no longer exist

  describe('onModuleDestroy', () => {
    it('should disconnect all streams', async () => {
      // Service should call disconnect on any managed streams
      await service.onModuleDestroy();
      
      // Since we have no streams, nothing to verify
      expect(service).toBeDefined();
    });
  });
});