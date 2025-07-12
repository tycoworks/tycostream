import { EventEmitter } from 'events';
import type { StreamEvent } from '../shared/viewCache.js';
import type { EventType } from '../shared/events.js';
import { logger } from '../shared/logger.js';

class PubSub extends EventEmitter {
  private log = logger.child({ component: 'pubsub' });

  constructor() {
    super();
    this.setMaxListeners(100); // Allow many concurrent subscriptions
  }

  publish(event: EventType, data: any): void {
    this.log.debug('Publishing event', { event, hasData: !!data });
    this.emit(event, data);
  }

  publishStreamEvent(viewName: string, streamEvent: StreamEvent): void {
    const eventName = `stream:${viewName}`;
    this.log.debug('Publishing stream event', { 
      viewName, 
      eventName, 
      diff: streamEvent.diff,
      rowKeys: Object.keys(streamEvent.row)
    });
    this.emit(eventName, streamEvent);
  }

  subscribeToStream(viewName: string, callback: (event: StreamEvent) => void): () => void {
    const eventName = `stream:${viewName}`;
    this.log.debug('Subscribing to stream', { viewName, eventName });
    
    this.on(eventName, callback);
    
    return () => {
      this.log.debug('Unsubscribing from stream', { viewName, eventName });
      this.off(eventName, callback);
    };
  }

  subscribe(event: EventType, callback: (data: any) => void): () => void {
    this.log.debug('Subscribing to event', { event });
    this.on(event, callback);
    
    return () => {
      this.log.debug('Unsubscribing from event', { event });
      this.off(event, callback);
    };
  }

  getListenerCount(event: EventType | string): number {
    return this.listenerCount(event);
  }
}

export const pubsub = new PubSub();
export { PubSub };