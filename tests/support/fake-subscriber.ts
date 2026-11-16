import type { SubscriberClient } from "../../src/stores/queue/queue-watch.js";

/** What each call of a `FakeSubscriber` answers: replaced by a test to fail or to hang. */
export interface SubscriberAnswers {
  connect: () => Promise<unknown>;
  subscribe: () => Promise<unknown>;
  ping: () => Promise<unknown>;
}

/**
 * A subscriber the test drives (agbossjs/agboss#1213): its answers are the test's, its messages and
 * `ready` events are sent by the test, and every call is counted. A connect emits `ready`, as
 * node-redis does; a close or a destroy leaves it closed.
 */
export class FakeSubscriber implements SubscriberClient {
  isReady = false;
  isOpen = false;
  readonly calls = { connect: 0, subscribe: 0, ping: 0, close: 0, destroy: 0 };
  readonly answers: SubscriberAnswers = {
    connect: () => Promise.resolve(),
    subscribe: () => Promise.resolve(),
    ping: () => Promise.resolve("PONG"),
  };
  channel: string | undefined;
  readonly #readyListeners: (() => void)[] = [];
  #message: (() => void) | undefined;

  on(event: string, listener: () => void): this {
    // only `ready` is ever emitted here: a listener of any other event never runs
    if (event === "ready") this.#readyListeners.push(listener);
    return this;
  }

  async connect(): Promise<this> {
    this.calls.connect += 1;
    await this.answers.connect();
    this.isOpen = true;
    this.ready();
    return this;
  }

  subscribe(channel: string, listener: () => void): Promise<unknown> {
    this.calls.subscribe += 1;
    this.channel = channel;
    this.#message = listener;
    return this.answers.subscribe();
  }

  ping(): Promise<unknown> {
    this.calls.ping += 1;
    return this.answers.ping();
  }

  close(): Promise<void> {
    this.calls.close += 1;
    this.isOpen = false;
    return Promise.resolve();
  }

  destroy(): void {
    this.calls.destroy += 1;
    this.isOpen = false;
  }

  /** The server is ready again (a reconnect): every `ready` listener runs. */
  ready(): void {
    this.isReady = true;
    for (const listener of [...this.#readyListeners]) listener();
  }

  /** A message on the subscribed channel. */
  publish(): void {
    this.#message?.();
  }
}

/** A promise that never settles: a server that does not answer. */
export const unanswered = (): Promise<never> => new Promise(() => undefined);
