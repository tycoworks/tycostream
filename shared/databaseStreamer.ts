export enum RowUpdateType {
  Insert = 'insert',
  Update = 'update',
  Delete = 'delete'
}

export interface RowUpdateEvent {
  type: RowUpdateType;
  row: Record<string, any>;
}

export interface StreamSubscriber {
  onUpdate(event: RowUpdateEvent): void;
}

export interface DatabaseStreamer {
  // Connection management
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  startStreaming(viewName: string): Promise<void>;
  stopStreaming(): Promise<void>;
  
  // Subscription management
  subscribe(subscriber: StreamSubscriber): () => void;
  getAllRows(): Record<string, any>[];
  getRow(primaryKey: any): Record<string, any> | undefined;
  
  // Status
  get streaming(): boolean;
  get subscriberCount(): number;
}

