import { Test, TestingModule } from '@nestjs/testing';
import { ViewService } from './view.service.js';
import { DatabaseService } from '../database/database.service.js';
import type { SourceDefinition } from '../config/source.types.js';
import { DataType } from '../config/source.types.js';
import { StreamMode } from '../common/types.js';
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
      stream: vi.fn().mockReturnValue(changes),
    } as unknown as Mocked<DatabaseService>;

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ViewService,
        { provide: DatabaseService, useValue: databaseService },
      ],
    }).compile();

    viewService = module.get<ViewService>(ViewService);
  });

  it('should open a live stream on the source and filter, and return its events', () => {
    const where = { id: { _eq: 1 } };

    expect(viewService.subscribe(trades, where)).toBe(changes);
    expect(databaseService.stream).toHaveBeenCalledWith(
      trades,
      where,
      StreamMode.Live,
    );
  });

  it('should open a separate stream for each view', () => {
    viewService.subscribe(trades);
    viewService.subscribe(trades);

    expect(databaseService.stream).toHaveBeenCalledTimes(2);
  });
});
