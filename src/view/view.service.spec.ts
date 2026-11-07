import { Test, TestingModule } from '@nestjs/testing';
import { ViewService } from './view.service.js';
import { DatabaseService } from '../database/database.service.js';
import type { SourceDefinition } from '../config/source.types.js';
import { DataType } from '../config/source.types.js';
import type { Mocked } from 'vitest';

const trades: SourceDefinition = {
  name: 'trades',
  primaryKeyField: 'id',
  fields: [{ name: 'id', dataType: DataType.Integer }],
};

describe('ViewService', () => {
  let viewService: ViewService;
  let databaseService: Mocked<DatabaseService>;
  const changes = { return: vi.fn() };

  beforeEach(async () => {
    databaseService = {
      subscribe: vi.fn().mockReturnValue(changes),
    } as unknown as Mocked<DatabaseService>;

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ViewService,
        { provide: DatabaseService, useValue: databaseService },
      ],
    }).compile();

    viewService = module.get<ViewService>(ViewService);
  });

  it('should pass the source and filter to the database and return its events', () => {
    const where = { id: { _eq: 1 } };

    expect(viewService.subscribe(trades, where)).toBe(changes);
    expect(databaseService.subscribe).toHaveBeenCalledWith(trades, where);
  });

  it('should open a separate database subscription for each view', () => {
    viewService.subscribe(trades);
    viewService.subscribe(trades);

    expect(databaseService.subscribe).toHaveBeenCalledTimes(2);
  });
});
