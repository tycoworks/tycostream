import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { DatabaseConnectionService } from './database-connection.service';
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

describe('DatabaseConnectionService', () => {
  let service: DatabaseConnectionService;
  let configService: ConfigService;

  beforeEach(async () => {
    // Clear all mocks before each test
    jest.clearAllMocks();
    
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DatabaseConnectionService,
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

    service = module.get<DatabaseConnectionService>(DatabaseConnectionService);
    configService = module.get<ConfigService>(ConfigService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('connect', () => {
    it('should create and connect a client with correct configuration', async () => {
      const client = await service.connect();

      expect(Client).toHaveBeenCalledWith({
        host: 'localhost',
        port: 6875,
        database: 'materialize',
        user: 'test',
        password: 'test',
        connectionTimeoutMillis: 10000,
        query_timeout: 0,
        keepAlive: true,
        keepAliveInitialDelayMillis: 10000,
      });
      expect(client.connect).toHaveBeenCalled();
      expect(client).toBeDefined();
    });

    it('should throw error when database config is not found', async () => {
      jest.spyOn(configService, 'get').mockReturnValue(undefined);

      await expect(service.connect()).rejects.toThrow('Database configuration not found');
    });

    it('should throw error when connection fails', async () => {
      const connectionError = new Error('Connection refused');
      
      // Mock Client to throw on connect
      (Client as unknown as jest.Mock).mockImplementationOnce(() => ({
        connect: jest.fn().mockRejectedValue(connectionError),
        end: jest.fn(),
        query: jest.fn(),
      }));

      await expect(service.connect()).rejects.toThrow('Database connection failed: Connection refused');
    });
  });

  describe('disconnect', () => {
    it('should disconnect a client', async () => {
      const client = await service.connect();
      await service.disconnect(client);

      expect(client.end).toHaveBeenCalled();
    });

    it('should throw error when disconnect fails', async () => {
      const disconnectError = new Error('Disconnect failed');
      
      // Create a client with end that rejects
      (Client as unknown as jest.Mock).mockImplementationOnce(() => ({
        connect: jest.fn().mockResolvedValue(undefined),
        end: jest.fn().mockRejectedValue(disconnectError),
        query: jest.fn(),
      }));

      const client = await service.connect();
      await expect(service.disconnect(client)).rejects.toThrow(disconnectError);
    });
  });

  describe('onModuleDestroy', () => {
    it('should close all connections', async () => {
      // Create multiple connections - each will have its own mock
      const client1 = await service.connect();
      const client2 = await service.connect();

      await service.onModuleDestroy();

      expect(client1.end).toHaveBeenCalled();
      expect(client2.end).toHaveBeenCalled();
    });

    it('should handle errors during cleanup gracefully', async () => {
      // Create a client with end that rejects
      (Client as unknown as jest.Mock).mockImplementationOnce(() => ({
        connect: jest.fn().mockResolvedValue(undefined),
        end: jest.fn().mockRejectedValue(new Error('Cleanup failed')),
        query: jest.fn(),
      }));

      const client = await service.connect();
      
      // Should not throw
      await expect(service.onModuleDestroy()).resolves.not.toThrow();
    });
  });
});