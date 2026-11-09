import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../database/database.service.js';
import type { RowUpdateBatches } from '../database/types.js';
import type { SourceDefinition } from '../config/source.types.js';
import type { Selection, StreamMode } from '../common/types.js';

/**
 * ViewService manages views of streaming data: a source plus a client's
 * selection of its rows. For now each view passes straight through to its
 * own database stream; a shared cache, or permissions, would go here.
 */
@Injectable()
export class ViewService {
  constructor(private readonly databaseService: DatabaseService) {}

  /**
   * A stream on a view of a source's rows the selection selects: its row
   * events, one complete timestamp at a time, the snapshot first. A
   * snapshot then ends; a live stream goes on. Ending the iteration closes
   * the stream.
   */
  stream(
    source: SourceDefinition,
    selection: Selection,
    mode: StreamMode,
  ): RowUpdateBatches {
    return this.databaseService.stream(source, selection, mode);
  }
}
