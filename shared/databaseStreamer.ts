export enum RowUpdateType {
  Insert = 'insert',
  Update = 'update',
  Delete = 'delete'
}

export interface RowUpdateEvent {
  type: RowUpdateType;
  row: Record<string, any>;
}

export interface DatabaseStreamer {
  // Lifecycle management
  start(): Promise<void>;
  stop(): Promise<void>;
  
  // Data access
  getAllRows(): Record<string, any>[];
  getRow(primaryKey: any): Record<string, any> | undefined;
  
  // Async iteration for streaming updates
  getUpdates(): AsyncIterableIterator<RowUpdateEvent>;
  
  // Status
  get streaming(): boolean;
  get subscriberCount(): number;
}

