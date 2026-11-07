import { Test, TestingModule } from '@nestjs/testing';
import { ViewService } from './view.service.js';
import { DatabaseStreamService } from '../database/stream.service.js';
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
  let streamService: Mocked<DatabaseStreamService>;
  const changes = { return: vi.fn() };

  beforeEach(async () => {
    streamService = {
      subscribe: vi.fn().mockReturnValue(changes),
    } as unknown as Mocked<DatabaseStreamService>;

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ViewService,
        { provide: DatabaseStreamService, useValue: streamService },
      ],
    }).compile();

    viewService = module.get<ViewService>(ViewService);
  });

  it('should pass the source and filter to the database and return its events', () => {
    const where = { id: { _eq: 1 } };

    expect(viewService.subscribe(trades, where)).toBe(changes);
    expect(streamService.subscribe).toHaveBeenCalledWith(trades, where);
  });

  it('should open a separate database subscription for each view', () => {
    viewService.subscribe(trades);
    viewService.subscribe(trades);

    expect(streamService.subscribe).toHaveBeenCalledTimes(2);
  });
});
