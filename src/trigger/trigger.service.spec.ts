import { Test, TestingModule } from '@nestjs/testing';
import { TriggerService } from './trigger.service';
import { CreateTriggerDto } from './trigger.dto';
import { ConflictException, NotFoundException } from '@nestjs/common';

describe('TriggerService', () => {
  let service: TriggerService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [TriggerService],
    }).compile();

    service = module.get<TriggerService>(TriggerService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('create', () => {
    const validDto: CreateTriggerDto = {
      name: 'test_trigger',
      source: 'trades',
      webhook: 'https://webhook.site/webhook',
      match: { price: { _gt: 100 } }
    };

    it('should create a trigger', async () => {
      const trigger = await service.create(validDto);
      
      expect(trigger.name).toBe('test_trigger');
      expect(trigger.source).toBe('trades');
      expect(trigger.webhook).toBe('https://webhook.site/webhook');
      expect(trigger.match.expression).toContain('price > 100');
      expect(trigger.createdAt).toBeInstanceOf(Date);
    });

    it('should automatically create unmatch as negation of match when not provided', async () => {
      const trigger = await service.create(validDto);
      
      expect(trigger.unmatch).toBeDefined();
      expect(trigger.unmatch.expression).toBe(`!(${trigger.match.expression})`);
      // Test the actual evaluation
      const testRow = { price: 150 };
      expect(trigger.match.evaluate(testRow)).toBe(true);
      expect(trigger.unmatch.evaluate(testRow)).toBe(false);
    });

    it('should create trigger with unmatch condition', async () => {
      const dtoWithUnmatch: CreateTriggerDto = {
        ...validDto,
        unmatch: { price: { _lte: 90 } }
      };

      const trigger = await service.create(dtoWithUnmatch);
      
      expect(trigger.unmatch).toBeDefined();
      expect(trigger.unmatch!.expression).toContain('price <= 90');
    });

    it('should throw ConflictException for duplicate name', async () => {
      await service.create(validDto);
      
      await expect(service.create(validDto)).rejects.toThrow(ConflictException);
      await expect(service.create(validDto)).rejects.toThrow(
        "Trigger with name 'test_trigger' already exists"
      );
    });
  });

  describe('get', () => {
    const validDto: CreateTriggerDto = {
      name: 'test_trigger',
      source: 'trades',
      webhook: 'https://webhook.site/test',
      match: { price: { _gt: 100 } }
    };

    it('should get a trigger by name', async () => {
      await service.create(validDto);
      
      const trigger = service.get('test_trigger');
      expect(trigger.name).toBe('test_trigger');
    });

    it('should throw NotFoundException for missing trigger', () => {
      expect(() => service.get('nonexistent')).toThrow(NotFoundException);
      expect(() => service.get('nonexistent')).toThrow("Trigger 'nonexistent' not found");
    });
  });

  describe('getAll', () => {
    it('should return empty array initially', () => {
      const triggers = service.getAll();
      expect(triggers).toEqual([]);
    });

    it('should return all triggers', async () => {
      const dto1: CreateTriggerDto = {
        name: 'trigger1',
        source: 'trades',
        webhook: 'https://webhook.site/1',
        match: { price: { _gt: 100 } }
      };

      const dto2: CreateTriggerDto = {
        name: 'trigger2',
        source: 'live_pnl',
        webhook: 'https://webhook.site/2',
        match: { realized_pnl: { _lt: -1000 } }
      };

      await service.create(dto1);
      await service.create(dto2);

      const triggers = service.getAll();
      expect(triggers).toHaveLength(2);
      expect(triggers.map(t => t.name)).toEqual(['trigger1', 'trigger2']);
    });
  });

  describe('delete', () => {
    const validDto: CreateTriggerDto = {
      name: 'test_trigger',
      source: 'trades',
      webhook: 'https://webhook.site/test',
      match: { price: { _gt: 100 } }
    };

    it('should delete a trigger', async () => {
      await service.create(validDto);
      expect(service.getAll()).toHaveLength(1);
      
      await service.delete('test_trigger');
      expect(service.getAll()).toHaveLength(0);
    });

    it('should throw NotFoundException when deleting nonexistent trigger', async () => {
      await expect(service.delete('nonexistent')).rejects.toThrow(NotFoundException);
    });
  });
});