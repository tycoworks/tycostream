import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PubSub } from '../src/pubsub.js';
import { EVENTS } from '../shared/events.js';
import type { StreamEvent } from '../shared/viewCache.js';

describe('PubSub', () => {
  let pubsub: PubSub;

  beforeEach(() => {
    pubsub = new PubSub();
  });

  it('should publish and subscribe to events', () => {
    const callback = vi.fn();
    const testData = { viewName: 'test', message: 'hello' };

    pubsub.subscribe(EVENTS.STREAM_CONNECTED, callback);
    pubsub.publish(EVENTS.STREAM_CONNECTED, testData);

    expect(callback).toHaveBeenCalledWith(testData);
    expect(callback).toHaveBeenCalledTimes(1);
  });

  it('should unsubscribe from events', () => {
    const callback = vi.fn();
    const testData = { viewName: 'test', message: 'hello' };

    const unsubscribe = pubsub.subscribe(EVENTS.STREAM_CONNECTED, callback);
    pubsub.publish(EVENTS.STREAM_CONNECTED, testData);

    expect(callback).toHaveBeenCalledTimes(1);

    unsubscribe();
    pubsub.publish(EVENTS.STREAM_CONNECTED, testData);

    // Should still only be called once
    expect(callback).toHaveBeenCalledTimes(1);
  });

  it('should handle stream events specifically', () => {
    const callback = vi.fn();
    const streamEvent: StreamEvent = {
      row: { id: '123', name: 'test' },
      diff: 1,
    };

    pubsub.subscribeToStream('test_view', callback);
    pubsub.publishStreamEvent('test_view', streamEvent);

    expect(callback).toHaveBeenCalledWith(streamEvent);
  });

  it('should track listener count', () => {
    const callback1 = vi.fn();
    const callback2 = vi.fn();

    expect(pubsub.getListenerCount(EVENTS.STREAM_CONNECTED)).toBe(0);

    pubsub.subscribe(EVENTS.STREAM_CONNECTED, callback1);
    expect(pubsub.getListenerCount(EVENTS.STREAM_CONNECTED)).toBe(1);

    pubsub.subscribe(EVENTS.STREAM_CONNECTED, callback2);
    expect(pubsub.getListenerCount(EVENTS.STREAM_CONNECTED)).toBe(2);
  });

  it('should handle multiple subscribers', () => {
    const callback1 = vi.fn();
    const callback2 = vi.fn();
    const testData = { viewName: 'test' };

    pubsub.subscribe(EVENTS.STREAM_CONNECTED, callback1);
    pubsub.subscribe(EVENTS.STREAM_CONNECTED, callback2);

    pubsub.publish(EVENTS.STREAM_CONNECTED, testData);

    expect(callback1).toHaveBeenCalledWith(testData);
    expect(callback2).toHaveBeenCalledWith(testData);
  });

  it('should isolate stream events by view name', () => {
    const callback1 = vi.fn();
    const callback2 = vi.fn();
    const streamEvent: StreamEvent = {
      row: { id: '123', name: 'test' },
      diff: 1,
    };

    pubsub.subscribeToStream('view1', callback1);
    pubsub.subscribeToStream('view2', callback2);

    pubsub.publishStreamEvent('view1', streamEvent);

    expect(callback1).toHaveBeenCalledWith(streamEvent);
    expect(callback2).not.toHaveBeenCalled();
  });
});