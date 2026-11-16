import { LogLevel, type ChildExecutionQueueWatch, type Clock, type Logger } from "@agboss/core";
import { seconds, type Milliseconds } from "@agboss/core/units";
import { destroyed } from "../../connection/close-bounded.js";
import { watchLiveness } from "../../connection/heartbeat.js";
import { RedisConnectionClosedError } from "../../errors.js";
import { openQueueWatch, type SubscriberClient } from "./queue-watch.js";

/** The pause before attempt `attempt` (from 0) to subscribe again: 1 s, doubling, at most 30 s. */
const pauseBefore = (attempt: number): Milliseconds => seconds(Math.min(2 ** attempt, 30));

/** What a watch that notices a silently dead connection is made of. */
export interface LivenessWatchOptions {
  /** A new subscriber client, not connected (`RedisConnection.subscriber`). */
  readonly subscriber: () => SubscriberClient;
  readonly channel: string;
  readonly onQueued: () => void;
  readonly clock: Clock;
  /** The longest a silently dead connection goes unnoticed, in seconds. */
  readonly livenessSeconds: number;
  /** Where a warning goes each time the connection is lost. */
  readonly logger: Logger;
}

/** One subscriber, its watch and the end of its ping. */
interface Subscribed {
  readonly client: SubscriberClient;
  readonly watch: ChildExecutionQueueWatch;
  readonly beat: AbortController;
}

/**
 * `openQueueWatch` that also notices a connection that dies silently (agbossjs/agboss#789) — a
 * half-open TCP connection behind a NAT or a load balancer: no FIN, no RST, the client sees
 * nothing and no message ever arrives. A `PING` over the subscriber every half of the liveness
 * bound, the answer due within the other half, all on the `Clock`; a connection that does not answer
 * is destroyed, `warn` says so, and a new subscriber subscribes after a pause that doubles from 1 s
 * up to 30 s, then wakes `onQueued` once (a child may have been queued meanwhile). A connection that
 * drops loudly is reconnected by node-redis, as before.
 */
export class LivenessWatch implements ChildExecutionQueueWatch {
  readonly #stopped = new AbortController();
  #current: Subscribed | undefined;
  #resubscribing: Promise<void> | undefined;

  private constructor(private readonly options: LivenessWatchOptions) {}

  /** Subscribes now; rejects when the server does not answer (the caller tries again later). */
  static async open(options: LivenessWatchOptions): Promise<LivenessWatch> {
    const watch = new LivenessWatch(options);
    await watch.#subscribe();
    return watch;
  }

  /**
   * Stops: a subscription in progress gives up at once (its client destroyed), then the current
   * one's ping ends and its client closes. What the subscription in progress left is read after it
   * settled, so a subscriber that answered as the close began is closed too.
   */
  async close(): Promise<void> {
    this.#stopped.abort();
    await this.#resubscribing;
    const current = this.#current;
    current?.beat.abort();
    await current?.watch.close();
  }

  async #subscribe(): Promise<void> {
    const { clock, channel, onQueued } = this.options;
    const client = this.options.subscriber();
    const attempt = new AbortController();
    try {
      const watch = await Promise.race([
        openQueueWatch(client, channel, onQueued, clock),
        this.#unanswered(AbortSignal.any([attempt.signal, this.#stopped.signal])),
      ]);
      const current = { client, watch, beat: new AbortController() };
      this.#current = current;
      void this.#heartbeat(current);
    } catch (error) {
      destroyed(client);
      throw error;
    } finally {
      attempt.abort();
    }
  }

  /** Rejects once the liveness bound has passed on the clock (the server is silent) or `signal` aborts. */
  async #unanswered(signal: AbortSignal): Promise<never> {
    await this.options.clock.sleep(seconds(this.options.livenessSeconds), signal);
    throw new Error("the server did not answer in time");
  }

  /** Pings until the watch closes; a connection that does not answer is lost. */
  async #heartbeat(current: Subscribed): Promise<void> {
    const dead = await watchLiveness({
      clock: this.options.clock,
      livenessSeconds: this.options.livenessSeconds,
      ping: () => current.client.ping(),
      signal: current.beat.signal,
    });
    // a beat ends with no reason only when the close aborted it
    if (dead !== undefined) this.#lost(current, dead);
  }

  /** The connection went silent: warn, drop its socket and subscribe on another. */
  #lost(current: Subscribed, reason: string): void {
    this.#current = undefined;
    this.options.logger.write({
      level: LogLevel.Warn,
      code: "child-queue.watch-connection-lost",
      message: `The child queue's subscription is lost (${reason}); subscribing again`,
      time: this.options.clock.now(),
    });
    // a silent connection never answers an orderly close: its socket is dropped
    destroyed(current.client);
    this.#resubscribing = this.#resubscribe();
  }

  /** Subscribes again after each pause until it is subscribed — then wakes once — or stopped. */
  async #resubscribe(): Promise<void> {
    const signal = this.#stopped.signal;
    for (let attempt = 0; ; attempt += 1) {
      await this.options.clock.sleep(pauseBefore(attempt), signal);
      if (signal.aborted) return;
      if (await this.#subscribed()) {
        // a child queued while the connection was silent sent a message nobody heard
        this.options.onQueued();
        return;
      }
    }
  }

  async #subscribed(): Promise<boolean> {
    try {
      await this.#subscribe();
      return true;
    } catch (error) {
      // the connection is stopped (the stop gave this watch up): nothing to subscribe on, ever
      if (error instanceof RedisConnectionClosedError) this.#stopped.abort();
      return false;
    }
  }
}
