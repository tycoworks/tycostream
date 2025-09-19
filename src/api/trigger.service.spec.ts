import { Test, TestingModule } from '@nestjs/testing';
import { HttpService } from '@nestjs/axios';
import { TriggerService } from './trigger.service';
import { ViewService } from '../view/view.service';
import { of } from 'rxjs';
import type { SourceDefinition } from '../config/source.types';
import { DataType } from '../config/source.types';

describe('TriggerService', () => {
  let triggerService: TriggerService;
  let viewService: jest.Mocked<ViewService>;
  let httpService: jest.Mocked<HttpService>;

  const testSourceDefinition: SourceDefinition = {
    name: 'test_source',
    primaryKeyField: 'id',
    fields: [
      { name: 'id', dataType: DataType.String },
      { name: 'field', dataType: DataType.Integer }
    ]
  };

  const source1Definition: SourceDefinition = {
    name: 'source1',
    primaryKeyField: 'id',
    fields: [
      { name: 'id', dataType: DataType.String },
      { name: 'field', dataType: DataType.Integer }
    ]
  };

  const source2Definition: SourceDefinition = {
    name: 'source2',
    primaryKeyField: 'id',
    fields: [
      { name: 'id', dataType: DataType.String },
      { name: 'field', dataType: DataType.Integer }
    ]
  };

  const nonExistentSourceDefinition: SourceDefinition = {
    name: 'non_existent_source',
    primaryKeyField: 'id',
    fields: [
      { name: 'id', dataType: DataType.String }
    ]
  };

  beforeEach(async () => {
    // Minimal mocks - just enough to satisfy dependencies
    viewService = {
      getUpdates: jest.fn().mockReturnValue(of())
    } as any;

    httpService = {
      post: jest.fn().mockReturnValue(of({ status: 200 }))
    } as any;

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TriggerService,
        { provide: ViewService, useValue: viewService },
        { provide: HttpService, useValue: httpService }
      ],
    }).compile();

    triggerService = module.get<TriggerService>(TriggerService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('createTrigger', () => {
    const testInput = {
      name: 'test_trigger',
      webhook: 'http://example.com/webhook',
      fire: { field: { _gt: 100 } },
      clear: { field: { _lte: 50 } }
    };

    it('should create and return a trigger', async () => {
      const result = await triggerService.createTrigger(testSourceDefinition, testInput);
      expect(result).toEqual(testInput);
    });

    it('should throw error if trigger name already exists for source', async () => {
      await triggerService.createTrigger(testSourceDefinition, testInput);

      await expect(
        triggerService.createTrigger(testSourceDefinition, testInput)
      ).rejects.toThrow('Trigger test_trigger already exists for source test_source');
    });

    it('should allow same trigger name for different sources', async () => {
      await triggerService.createTrigger(source1Definition, testInput);
      const result = await triggerService.createTrigger(source2Definition, testInput);

      expect(result).toEqual(testInput);
    });
  });

  describe('getTrigger', () => {
    const testInput = {
      name: 'test_trigger',
      webhook: 'http://example.com/webhook',
      fire: { field: { _gt: 100 } }
    };

    beforeEach(async () => {
      await triggerService.createTrigger(testSourceDefinition, testInput);
    });

    it('should return an existing trigger', async () => {
      const trigger = await triggerService.getTrigger(testSourceDefinition, 'test_trigger');
      
      expect(trigger.name).toBe('test_trigger');
      expect(trigger.webhook).toBe('http://example.com/webhook');
      expect(trigger.fire).toEqual(testInput.fire);
    });

    it('should throw error if trigger does not exist', async () => {
      await expect(
        triggerService.getTrigger(testSourceDefinition, 'non_existent')
      ).rejects.toThrow('Trigger non_existent not found for source test_source');
    });

  });

  describe('listTriggers', () => {
    it('should return empty array for non-existent source', async () => {
      const triggers = await triggerService.listTriggers(nonExistentSourceDefinition);
      expect(triggers).toEqual([]);
    });

    it('should return empty array for source with no triggers', async () => {
      // Create and delete a trigger to ensure the source map exists but is empty
      await triggerService.createTrigger(testSourceDefinition, {
        name: 'temp',
        webhook: 'http://example.com',
        fire: { field: { _gt: 0 } }
      });
      await triggerService.deleteTrigger(testSourceDefinition, 'temp');

      const triggers = await triggerService.listTriggers(testSourceDefinition);
      expect(triggers).toEqual([]);
    });

    it('should return all triggers for a source', async () => {
      await triggerService.createTrigger(testSourceDefinition, {
        name: 'trigger1',
        webhook: 'http://example.com/webhook1',
        fire: { field: { _gt: 100 } }
      });

      await triggerService.createTrigger(testSourceDefinition, {
        name: 'trigger2',
        webhook: 'http://example.com/webhook2',
        fire: { field: { _lt: 50 } }
      });

      const triggers = await triggerService.listTriggers(testSourceDefinition);
      
      expect(triggers).toHaveLength(2);
      const names = triggers.map(t => t.name);
      expect(names).toContain('trigger1');
      expect(names).toContain('trigger2');
    });

    it('should not return triggers from other sources', async () => {
      await triggerService.createTrigger(source1Definition, {
        name: 'trigger1',
        webhook: 'http://example.com/webhook1',
        fire: { field: { _gt: 100 } }
      });

      await triggerService.createTrigger(source2Definition, {
        name: 'trigger2',
        webhook: 'http://example.com/webhook2',
        fire: { field: { _lt: 50 } }
      });

      const triggers = await triggerService.listTriggers(source1Definition);
      
      expect(triggers).toHaveLength(1);
      expect(triggers[0].name).toBe('trigger1');
    });
  });

  describe('deleteTrigger', () => {
    const testInput = {
      name: 'test_trigger',
      webhook: 'http://example.com/webhook',
      fire: { field: { _gt: 100 } }
    };

    beforeEach(async () => {
      await triggerService.createTrigger(testSourceDefinition, testInput);
    });

    it('should delete and return the trigger', async () => {
      const result = await triggerService.deleteTrigger(testSourceDefinition, 'test_trigger');

      expect(result.name).toBe('test_trigger');
      expect(result.webhook).toBe('http://example.com/webhook');
      
      // Verify it's actually deleted
      await expect(
        triggerService.getTrigger(testSourceDefinition, 'test_trigger')
      ).rejects.toThrow('Trigger test_trigger not found for source test_source');
    });

    it('should throw error if trigger does not exist', async () => {
      await expect(
        triggerService.deleteTrigger(testSourceDefinition, 'non_existent')
      ).rejects.toThrow('Trigger non_existent not found for source test_source');
    });

    it('should throw error if source does not exist', async () => {
      await expect(
        triggerService.deleteTrigger(nonExistentSourceDefinition, 'test_trigger')
      ).rejects.toThrow('Trigger test_trigger not found for source non_existent_source');
    });

    it('should only delete the specified trigger', async () => {
      await triggerService.createTrigger(testSourceDefinition, {
        name: 'trigger2',
        webhook: 'http://example.com/webhook2',
        fire: { field: { _lt: 50 } }
      });

      await triggerService.deleteTrigger(testSourceDefinition, 'test_trigger');

      // trigger2 should still exist
      const remaining = await triggerService.listTriggers(testSourceDefinition);
      expect(remaining).toHaveLength(1);
      expect(remaining[0].name).toBe('trigger2');
    });
  });

  describe('onModuleDestroy', () => {
    it('should complete without error when there are no triggers', async () => {
      await expect(triggerService.onModuleDestroy()).resolves.not.toThrow();
    });

    it('should complete without error when there are triggers', async () => {
      await triggerService.createTrigger(source1Definition, {
        name: 'trigger1',
        webhook: 'http://example.com/webhook1',
        fire: { field: { _gt: 100 } }
      });

      await triggerService.createTrigger(source2Definition, {
        name: 'trigger2',
        webhook: 'http://example.com/webhook2',
        fire: { field: { _lt: 50 } }
      });

      await expect(triggerService.onModuleDestroy()).resolves.not.toThrow();
    });
  });
});