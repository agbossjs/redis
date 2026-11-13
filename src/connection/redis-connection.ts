import {
  ApplicationContext,
  Clock,
  EnvironmentField,
  Injectable,
  type OnDestroy,
  type OnInit,
} from "@agboss/core";
import { createClient } from "@redis/client";
import { closeBounded } from "./close-bounded.js";
import { RedisSettingsError } from "../errors.js";
import {
  durabilityOf,
  durabilityProblemsOfServer,
  requireDurable,
  type RedisDurability,
  type RedisDurabilityOptOut,
} from "./durability.js";
import { requireOnePrimary, topologyOfServer, type RedisTopology } from "./deployment.js";
import {
  DEFAULT_KEY_PREFIX,
  DEFAULT_WATCH_LIVENESS_SECONDS,
  settingsOfEnvironment,
  type RedisConnectionSettings,
} from "./settings.js";

/** The client of one application instance (node-redis, RESP2 replies). */
export type RedisClient = ReturnType<typeof createClient>;

/** How many times the first connection is retried before `onInit` fails (about 1.5 s in all). */
export const START_CONNECT_RETRIES = 5;

/** The wait before reconnect attempt `retries` (from 1): 100 ms more each time, at most 1 s. */
export const reconnectDelayOf = (retries: number): number => Math.min(retries * 100, 1000);

/**
 * The reconnect strategy: before the client was first ready, `START_CONNECT_RETRIES` attempts, then
 * `onInit` rejects with the connection's error — a start never hangs on a server that is down;
 * once it was ready, a dropped connection is retried for as long as it takes.
 */
export function reconnectStrategyOf(
  wasReady: () => boolean,
): (retries: number, cause: Error) => number | Error {
  return (retries, cause) =>
    !wasReady() && retries >= START_CONNECT_RETRIES ? cause : reconnectDelayOf(retries + 1);
}

/**
 * The subscriber's wait unit before a reconnect (agbossjs/agboss#777), doubled each time. node-redis
 * ignores the wait for a dropped connection's first attempt (it reconnects at once, ~5 ms), so the
 * first wait that counts is the second one, 2 s.
 */
export const SUBSCRIBER_RECONNECT_FIRST_MS = 1000;
/** The subscriber's longest wait before a reconnect: 30 s, the core's sweep. */
export const SUBSCRIBER_RECONNECT_MAX_MS = 30_000;

/**
 * The subscriber's wait before reconnect attempt `retries` (from 0): 1 s, 2 s, 4 s, … at most 30 s —
 * the strategy's answer for attempt 0 is not waited (node-redis reconnects at once), the rest are.
 */
export const subscriberReconnectDelayOf = (retries: number): number =>
  Math.min(SUBSCRIBER_RECONNECT_FIRST_MS * 2 ** Math.min(retries, 5), SUBSCRIBER_RECONNECT_MAX_MS);

/**
 * The subscriber's reconnect strategy: before it was first ready, none — its first connect
 * rejects at once (the core opens the watch again at its next sweep); once it was ready, a dropped
 * connection is retried for as long as it takes, `subscriberReconnectDelayOf` apart.
 */
export function subscriberReconnectStrategyOf(
  wasReady: () => boolean,
): (retries: number, cause: Error) => number | Error {
  return (retries, cause) => (wasReady() ? subscriberReconnectDelayOf(retries) : cause);
}

type ReconnectStrategy = (retries: number, cause: Error) => number | Error;

/** A client of `url`: parsed here, connected by its owner. */
function clientOf(
  url: string,
  strategyOf: (wasReady: () => boolean) => ReconnectStrategy = reconnectStrategyOf,
): RedisClient {
  let wasReady = false;
  let client: RedisClient;
  try {
    client = createClient({
      url,
      socket: { reconnectStrategy: strategyOf(() => wasReady) },
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new RedisSettingsError({
      message: `redisUrl is not a usable Redis URL: ${reason}`,
      cause: error,
    });
  }
  client.on("ready", () => {
    wasReady = true;
  });
  // a dropped connection reconnects by itself; an operation in flight rejects with its own error —
  // nothing to do here but not crash the process on the client's `error` event
  client.on("error", () => undefined);
  return client;
}

/**
 * The Redis server of one application instance: one node-redis client on the environment's
 * `redisUrl`, shared by every Redis store the application lists. At `onInit` it connects and
 * checks the server keeps an acknowledged write across a crash (`appendonly yes`,
 * `appendfsync always`): otherwise it fails with `RedisDurabilityError` and closes the client,
 * unless `redisDurabilityOptOut` names the lost guarantee. At `onDestroy`, after its stores, it
 * closes the client. Created by the container (`deps: [ApplicationContext]`) or by a script or a
 * test (`new RedisConnection({ url })`). Only coordination stores live here (leases, rate limits,
 * the child queue); fenced effects and outbound calls stay on a durable store (agbossjs/agboss#526).
 */
@Injectable({
  deps: [ApplicationContext, Clock],
  // checked at the application's assembly (agbossjs/agboss#511): a contract without redisUrl
  // fails with [environment.missing-field] before anything starts
  environmentFields: {
    redisUrl: EnvironmentField.secret(),
    redisDurabilityOptOut: EnvironmentField.text({ optional: true }),
    redisKeyPrefix: EnvironmentField.text({ optional: true }),
    redisWatchLivenessSeconds: EnvironmentField.integer({ optional: true }),
  },
})
export class RedisConnection implements OnInit, OnDestroy {
  /** The instance's client: every store's commands and scripts. */
  readonly client: RedisClient;
  /** What every key of the stores starts with (`redisKeyPrefix`, default `agboss:`). */
  readonly keyPrefix: string;
  /**
   * The clock that bounds the close at the stop (agbossjs/agboss#923); none: the close is in order only.
   *
   * @internal
   */
  readonly clock: Clock | undefined;
  /**
   * How long the child queue's watch may go without noticing a silently dead connection, in seconds
   * (`redisWatchLivenessSeconds`, agbossjs/agboss#789).
   *
   * @internal
   */
  readonly watchLivenessSeconds: number;
  readonly #optOut: RedisDurabilityOptOut | undefined;
  readonly #url: string;

  /**
   * @param clock bounds the close at the stop (agbossjs/agboss#923); a connection built without
   *   one closes in order only.
   */
  constructor(source: ApplicationContext | RedisConnectionSettings, clock?: Clock) {
    this.clock = clock;
    const settings =
      source instanceof ApplicationContext ? settingsOfEnvironment(source.environment) : source;
    this.#optOut = settings.durabilityOptOut;
    this.keyPrefix = settings.keyPrefix ?? DEFAULT_KEY_PREFIX;
    this.#url = settings.url;
    this.watchLivenessSeconds = settings.watchLivenessSeconds ?? DEFAULT_WATCH_LIVENESS_SECONDS;
    this.client = clientOf(settings.url);
  }

  /**
   * A new client on the same server for pub/sub (`SUBSCRIBE` takes a connection over), not
   * connected: its owner connects and closes it. Its first connect rejects at once when the server
   * does not answer; once ready, a dropped connection reconnects at once (node-redis skips the first
   * wait, ~5 ms), then, while the server stays down, 2 s, 4 s, … at most 30 s apart, and
   * subscribes again before it is ready (agbossjs/agboss#777). The child queue's watch only — not
   * part of the package's API (agbossjs/agboss#891).
   *
   * @internal
   */
  subscriber(): RedisClient {
    return clientOf(this.#url, subscriberReconnectStrategyOf);
  }

  /**
   * The server's durability now (`CONFIG GET appendonly`, `appendfsync`, …), a report: each
   * setting found short and the opt-out given, if any. Never rejects for a short server
   * (agbossjs/agboss#891: `requireDurability()` does).
   */
  async durability(): Promise<RedisDurability> {
    const problems = await durabilityProblemsOfServer((parameter) =>
      this.client.configGet(parameter),
    );
    return durabilityOf(problems, this.#optOut);
  }

  /**
   * Rejects with `RedisDurabilityError` when the server can lose an acknowledged write and no
   * opt-out accepts that; else resolves with the report (`durability()`).
   */
  async requireDurability(): Promise<RedisDurability> {
    const durability = await this.durability();
    requireDurable(durability);
    return durability;
  }

  /**
   * The server's deployment now (`INFO replication` / `cluster`), a report: its role, cluster
   * mode and each way it falls short of one primary. Never rejects for an unsupported server
   * (agbossjs/agboss#891: `requireSupportedTopology()` does).
   */
  topology(): Promise<RedisTopology> {
    return topologyOfServer((section) => this.client.info(section));
  }

  /**
   * Rejects with `RedisDeploymentError` for a replica, a cluster, or an `INFO` it may not read —
   * no opt-out; else resolves with the report (`topology()`).
   */
  async requireSupportedTopology(): Promise<RedisTopology> {
    const topology = await this.topology();
    requireOnePrimary(topology);
    return topology;
  }

  /** One `PING`: every Redis store's `ping()`. Rejects when the server does not answer. */
  async ping(): Promise<void> {
    await this.client.ping();
  }

  /**
   * Connects, then the start checks: a server that is not one primary, or that can lose an
   * acknowledged write, is refused.
   */
  async onInit(): Promise<void> {
    await this.client.connect();
    try {
      await this.requireSupportedTopology();
      await this.requireDurability();
    } catch (error) {
      await this.onDestroy();
      throw error;
    }
  }

  /** Closes the client when the instance stops (its stores are destroyed first: they depend on it). */
  async onDestroy(): Promise<void> {
    await closeBounded(this.client, this.clock);
  }
}
