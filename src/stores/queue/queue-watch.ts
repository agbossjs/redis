import type { ChildExecutionQueueWatch, Clock } from "@agboss/core";
import { closeBounded, destroyed } from "../../connection/close-bounded.js";

/**
 * What the watch uses of its subscriber, a node-redis client of its own
 * (`RedisConnection.subscriber()`): its state, its `ready` event, connect, subscribe, a ping (the
 * liveness watch), an orderly close and a destroy. Narrow, so a test drives each event itself.
 */
export interface SubscriberClient {
  readonly isReady: boolean;
  readonly isOpen: boolean;
  on(event: "ready", listener: () => void): unknown;
  connect(): Promise<unknown>;
  subscribe(channel: string, listener: () => void): Promise<unknown>;
  ping(): Promise<unknown>;
  close(): Promise<unknown>;
  destroy(): void;
}

/**
 * The child queue's watch (agbossjs/agboss#777) on `subscriber`, a client of its own: connected and
 * subscribed to `channel` before it resolves; each message wakes `onQueued`. After a reconnect the
 * client subscribes again before it is ready (node-redis resubscribes in its socket's initiator),
 * so the `ready` of a reconnect wakes `onQueued` once — for what was published while it was down.
 * Nothing wakes once closed. A first connect or subscribe that fails rejects, the client closed.
 * A subscriber already connected is used as it is.
 */
export async function openQueueWatch(
  subscriber: SubscriberClient,
  channel: string,
  onQueued: () => void,
  clock?: Clock,
): Promise<ChildExecutionQueueWatch> {
  let isOpen = true;
  let wasReady = subscriber.isReady;
  const wake = (): void => {
    if (isOpen) onQueued();
  };
  subscriber.on("ready", () => {
    if (wasReady) wake();
    wasReady = true;
  });
  try {
    if (!subscriber.isOpen) await subscriber.connect();
    await subscriber.subscribe(channel, wake);
  } catch (error) {
    isOpen = false;
    destroyed(subscriber);
    throw error;
  }
  return {
    close: async () => {
      if (!isOpen) return;
      isOpen = false;
      await closeBounded(subscriber, clock);
    },
  };
}
