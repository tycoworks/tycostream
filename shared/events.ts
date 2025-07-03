export const EVENTS = {
  STREAM_CONNECTED: 'stream.connected',
  STREAM_DISCONNECTED: 'stream.disconnected',
  STREAM_ERROR: 'stream.error',
  STREAM_UPDATE_RECEIVED: 'stream.updateReceived',
  STREAM_UPDATE_PARSED: 'stream.updateParsed',
  CLIENT_SUBSCRIBED: 'client.subscribed',
  CLIENT_UNSUBSCRIBED: 'client.unsubscribed',
  SCHEMA_LOADED: 'schema.loaded',
  SHUTDOWN_REQUESTED: 'shutdown.requested',
} as const;

export type EventType = typeof EVENTS[keyof typeof EVENTS];