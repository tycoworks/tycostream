import { Test, TestingModule } from '@nestjs/testing';
import { ViewService } from './view.service.js';
import { DatabaseService } from '../database/database.service.js';
import type { SourceDefinition } from '../config/source.types.js';
import { StreamMode, PostgresType } from '../common/types.js';
import type { Mocked } from 'vitest';

const trades: SourceDefinition = {
  name: 'trades',
  primaryKeyField: 'id',
  fields: [{ name: 'id', type: PostgresType.Int4 }],
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

  it('should open a stream of the mode on the source and selection, and return its events', () => {
    const selection = { where: { id: { _eq: 1 } }, limit: 10 };

    expect(viewService.stream(trades, selection, StreamMode.Live)).toBe(
      changes,
    );
    expect(databaseService.stream).toHaveBeenCalledWith(
      trades,
      selection,
      StreamMode.Live,
    );
  });

  it('should open a separate stream for each view', () => {
    viewService.stream(trades, {}, StreamMode.Live);
    viewService.stream(trades, {}, StreamMode.Snapshot);

    expect(databaseService.stream).toHaveBeenCalledTimes(2);
  });
});
