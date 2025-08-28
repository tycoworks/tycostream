import { Test, TestingModule } from '@nestjs/testing';
import { TriggerController } from './trigger.controller';
import { TriggerService } from './trigger.service';
import { CreateTriggerDto } from './trigger.dto';
import { Trigger } from './trigger';

describe('TriggerController', () => {
  let controller: TriggerController;
  let service: TriggerService;

  const mockTrigger: Trigger = new Trigger({
    name: 'test_trigger',
    source: 'trades',
    match: {
      condition: {
        evaluate: () => true,
        fields: new Set(['price']),
        expression: 'price > 100'
      },
      webhook: 'https://webhook.site/test'
    }
  });

  const mockService = {
    create: jest.fn(),
    getAll: jest.fn(),
    get: jest.fn(),
    delete: jest.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [TriggerController],
      providers: [
        {
          provide: TriggerService,
          useValue: mockService,
        },
      ],
    }).compile();

    controller = module.get<TriggerController>(TriggerController);
    service = module.get<TriggerService>(TriggerService);
    
    // Clear mocks
    jest.clearAllMocks();
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  describe('createTrigger', () => {
    const createDto: CreateTriggerDto = {
      name: 'test_trigger',
      source: 'trades',
      match: {
        condition: { price: { _gt: 100 } },
        webhook: 'https://webhook.site/test'
      }
    };

    it('should create a trigger via POST /triggers', async () => {
      mockService.create.mockResolvedValue(mockTrigger);
      
      const result = await controller.createTrigger(createDto);
      
      expect(result).toBe(mockTrigger);
      expect(mockService.create).toHaveBeenCalledWith(createDto);
    });
  });

  describe('getAll', () => {
    it('should return all triggers', async () => {
      const triggers = [mockTrigger];
      mockService.getAll.mockReturnValue(triggers);
      
      const result = await controller.getAll();
      
      expect(result).toBe(triggers);
      expect(mockService.getAll).toHaveBeenCalled();
    });
  });

  describe('get', () => {
    it('should return a specific trigger', async () => {
      mockService.get.mockReturnValue(mockTrigger);
      
      const result = await controller.get('test_trigger');
      
      expect(result).toBe(mockTrigger);
      expect(mockService.get).toHaveBeenCalledWith('test_trigger');
    });
  });

  describe('deleteTrigger', () => {
    it('should delete a trigger', async () => {
      mockService.delete.mockResolvedValue(undefined);
      
      await controller.deleteTrigger('test_trigger');
      
      expect(mockService.delete).toHaveBeenCalledWith('test_trigger');
    });
  });
});