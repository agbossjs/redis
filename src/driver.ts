import type { SecretRef } from "@agboss/core";
import {
  defineStorageDriver,
  StorageRole,
  type ClusterDriver,
  type DriverTimeouts,
} from "@agboss/core/stores";
import { RedisConnection } from "./connection/redis-connection.js";
import { timeoutSettingsOf } from "./connection/driver-settings.js";
import type { RedisDurabilityOptOut } from "./connection/durability.js";
import { REDIS_COORDINATION_STORES } from "./stores/coordination-stores.js";

/** The time options of `RedisDriver`: the child queue's watch is the only wait Redis has of its own. */
export type RedisDriverTimeouts = Pick<DriverTimeouts, "watchLiveness">;

/** `RedisDriver({ url })` options (agbossjs/agboss#1321). */
export interface RedisDriverOptions {
  /** The server: `secret("REDIS_URL")`, read once when the application starts, never printed. */
  readonly url: SecretRef;
  /** What every key starts with (default `agboss:`): two applications on one server, each under its own. */
  readonly keyPrefix?: string;
  /** Start on a server that can lose an acknowledged write — the opt-out names that loss. */
  readonly durabilityOptOut?: RedisDurabilityOptOut;
  /** How long the child queue's watch may stay silent before it is re-opened (default `DEFAULT_WATCH_LIVENESS`, at least 2 s). */
  readonly timeouts?: RedisDriverTimeouts;
}

/**
 * The cluster on Redis (`@ClusterStorage({ driver: RedisDriver({ url: secret("REDIS_URL") }) })`):
 * the coordination stores — the lease store, the child queue and the rate limits — on the one
 * durable primary of the instance's connection. The cluster decides who holds a tree's lease; the
 * database's lease row under `EXECUTION_ID_STORE` (the `@DatabaseStorage` driver's lease store) is
 * the authority for its token, its stop mark, its external pause and the fence (D6), written
 * before Redis acknowledges. Every other store stays on the database.
 */
export function RedisDriver(options: RedisDriverOptions): ClusterDriver {
  const { url, keyPrefix, durabilityOptOut, timeouts } = options;
  return defineStorageDriver({
    role: StorageRole.Cluster,
    backend: "redis",
    describes: "redis",
    settings: {
      kind: "redis",
      url,
      ...(keyPrefix === undefined ? {} : { keyPrefix }),
      ...(durabilityOptOut === undefined ? {} : { durabilityOptOut }),
      ...timeoutSettingsOf(timeouts),
    },
    providers: [RedisConnection, ...REDIS_COORDINATION_STORES],
  });
}
