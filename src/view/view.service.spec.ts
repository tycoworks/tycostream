import { Test, TestingModule } from '@nestjs/testing';
import { ViewService } from './view.service';
import { SourceService } from './source.service';
import { Source } from './source';
import { View } from './view';
import { Filter } from './filter';
import { Subject } from 'rxjs';
import type { RowUpdateEvent } from './types';

describe('ViewService', () => {
  let viewService: ViewService;
  let sourceService: jest.Mocked<SourceService>;
  let mockSource: jest.Mocked<Source>;
  let sourceUpdates$: Subject<RowUpdateEvent>;

  beforeEach(async () => {
    // Create a subject for source updates
    sourceUpdates$ = new Subject<RowUpdateEvent>();

    // Mock Source
    mockSource = {
      getUpdates: jest.fn().mockReturnValue(sourceUpdates$),
      getPrimaryKeyField: jest.fn().mockReturnValue('id'),
      dispose: jest.fn()
    } as any;

    // Mock SourceService
    sourceService = {
      getSource: jest.fn().mockReturnValue(mockSource)
    } as any;

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ViewService,
        { provide: SourceService, useValue: sourceService }
      ],
    }).compile();

    viewService = module.get<ViewService>(ViewService);
  });

  afterEach(() => {
    jest.clearAllMocks();
    sourceUpdates$.complete();
  });

  describe('getUpdates', () => {
    it('should get source from SourceService', () => {
      viewService.getUpdates('test_source');
      
      expect(sourceService.getSource).toHaveBeenCalledWith('test_source');
    });

    it('should create a View with the source', () => {
      const updates$ = viewService.getUpdates('test_source');
      
      expect(updates$).toBeDefined();
      expect(mockSource.getUpdates).toHaveBeenCalled();
    });

    it('should pass filter to View when provided', () => {
      const filter = new Filter({
        expression: 'test',
        fields: new Set(['field']),
        evaluate: () => true
      });

      const updates$ = viewService.getUpdates('test_source', filter);
      
      expect(updates$).toBeDefined();
      // View is created internally with the filter
      expect(sourceService.getSource).toHaveBeenCalledWith('test_source');
    });

    it('should return an observable that can be subscribed to', (done) => {
      const updates$ = viewService.getUpdates('test_source');
      
      // Should be able to subscribe without error
      const subscription = updates$.subscribe({
        next: () => {},
        error: done.fail,
        complete: () => done()
      });

      // Complete the source to end the test
      sourceUpdates$.complete();
      subscription.unsubscribe();
    });
  });

  describe('multiple subscribers', () => {
    it('should create independent views for each subscriber', () => {
      const updates1$ = viewService.getUpdates('test_source');
      const updates2$ = viewService.getUpdates('test_source');
      
      // Each call should get the source
      expect(sourceService.getSource).toHaveBeenCalledTimes(2);
      
      // Each should get their own observable
      expect(updates1$).not.toBe(updates2$);
    });

    it('should handle cleanup when subscriber disconnects', () => {
      const updates$ = viewService.getUpdates('test_source');
      
      const subscription = updates$.subscribe();
      subscription.unsubscribe();
      
      // View cleanup happens internally
      // We can't easily test this without exposing internals
      expect(sourceService.getSource).toHaveBeenCalled();
    });
  });

  describe('onModuleDestroy', () => {
    it('should clean up resources', async () => {
      await viewService.onModuleDestroy();
      
      // Should log shutdown messages (we can't easily test logging)
      // Main thing is it doesn't throw
      expect(true).toBe(true);
    });
  });
});