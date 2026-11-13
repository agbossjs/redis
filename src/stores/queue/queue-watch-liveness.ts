import { LogLevel, type ChildExecutionQueueWatch, type Clock, type Logger } from "@agboss/core";
import { seconds } from "@agboss/core/units";
import { watchLiveness } from "../../connection/heartbeat.js";
import type { RedisClient } from "../../connection/redis-connection.js";
import { openQueueWatch } from "./queue-watch.js";

/** The pauses before each attempt to subscribe again; the last one repeats. */
const PAUSES = [1, 2, 4, 8, 16, 30].map((pause) => seconds(pause));

/** What a watch that notices a silently dead connection is made of. */
export interface LivenessWatchOptions {
  /** A new subscriber client, not connected (`RedisConnection.subscriber`). */
  readonly subscriber: () => RedisClient;
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
  readonly client: RedisClient;
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

  async close(): Promise<void> {
    this.#stopped.abort();
    const current = this.#current;
    this.#current = undefined;
    current?.beat.abort();
    await this.#resubscribing;
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
      if (this.#stopped.signal.aborted) {
        await watch.close();
        return;
      }
      this.#current = current;
      void this.#heartbeat(current);
    } catch (error) {
      if (client.isOpen) client.destroy();
      throw error;
    } finally {
      attempt.abort();
    }
  }

  /** Rejects when the liveness bound has passed on the clock (the server is silent) or `signal` aborts. */
  async #unanswered(signal: AbortSignal): Promise<never> {
    await this.options.clock.sleep(seconds(this.options.livenessSeconds), signal);
    throw new Error("the server did not answer in time");
  }

  /** Pings until the subscriber is replaced; one that does not answer is lost. */
  async #heartbeat(current: Subscribed): Promise<void> {
    const dead = await watchLiveness({
      clock: this.options.clock,
      livenessSeconds: this.options.livenessSeconds,
      ping: () => current.client.ping(),
      signal: current.beat.signal,
    });
    if (dead !== undefined) this.#lost(current, dead);
  }

  /** The connection went silent: subscribe on another, unless the watch is closed or it was replaced. */
  #lost(current: Subscribed, reason: string): void {
    if (this.#stopped.signal.aborted || this.#current !== current) return;
    this.#current = undefined;
    current.beat.abort();
    this.options.logger.write({
      level: LogLevel.Warn,
      code: "child-queue.watch-connection-lost",
      message: `The child queue's subscription is lost (${reason}); subscribing again`,
      time: this.options.clock.now(),
    });
    // a silent connection never answers an orderly close: its socket is dropped
    if (current.client.isOpen) current.client.destroy();
    this.#resubscribing = this.#resubscribe().finally(() => {
      this.#resubscribing = undefined;
    });
  }

  async #resubscribe(): Promise<void> {
    const signal = this.#stopped.signal;
    const isStopped = (): boolean => signal.aborted;
    for (let attempt = 0; ; attempt += 1) {
      const pause = PAUSES[Math.min(attempt, PAUSES.length - 1)] ?? seconds(30);
      await this.options.clock.sleep(pause, signal).catch(() => undefined);
      if (isStopped()) return;
      if (await this.#subscribed()) {
        if (this.#current !== undefined) this.options.onQueued();
        return;
      }
    }
  }

  async #subscribed(): Promise<boolean> {
    try {
      await this.#subscribe();
      return true;
    } catch {
      return false;
    }
  }
}
