// Streaming and cache event types
export interface StreamEvent {
  row: Record<string, any>;
  diff: number;
  timestamp: bigint;
}

export type RowUpdateType = 'insert' | 'update' | 'delete';

export interface RowUpdateEvent {
  type: RowUpdateType;
  row: Record<string, any>;
}

export interface CacheSubscriber {
  onUpdate(event: RowUpdateEvent): void;
}

export interface ViewCache {
  handleRowUpdate(event: StreamEvent): void;
  getRow(primaryKey: any): Record<string, any> | undefined;
  size(): number;
  clear(): void;
  getAllRows(): Record<string, any>[];
  subscribe(subscriber: CacheSubscriber): () => void;
  getSubscriberCount(event: string): number;
}

