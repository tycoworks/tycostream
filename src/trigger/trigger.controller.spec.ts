import { Test, TestingModule } from '@nestjs/testing';
import { TriggerController } from './trigger.controller';
import { NotImplementedException } from '@nestjs/common';

describe('TriggerController', () => {
  let controller: TriggerController;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [TriggerController],
    }).compile();

    controller = module.get<TriggerController>(TriggerController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  // All methods should throw NotImplementedException until moved to api module
  it('should throw NotImplementedException for createTrigger', async () => {
    await expect(controller.createTrigger({ 
      name: 'test', 
      source: 'test', 
      webhook: 'http://test.com',
      match: {}
    })).rejects.toThrow(NotImplementedException);
  });

  it('should throw NotImplementedException for getAll', async () => {
    await expect(controller.getAll()).rejects.toThrow(NotImplementedException);
  });

  it('should throw NotImplementedException for get', async () => {
    await expect(controller.get('test')).rejects.toThrow(NotImplementedException);
  });

  it('should throw NotImplementedException for deleteTrigger', async () => {
    await expect(controller.deleteTrigger('test')).rejects.toThrow(NotImplementedException);
  });
});