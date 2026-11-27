import { env, secret } from "@agboss/core";
import { StorageRole } from "@agboss/core/stores";
import { sec } from "@agboss/core/units";
import { describe, expect, expectTypeOf, it } from "vitest";
import {
  REDIS_COORDINATION_STORES,
  RedisConnection,
  RedisDriver,
  RedisDurabilityOptOut,
  RedisSettingsError,
  type RedisClient,
} from "../../src/index.js";
import { settingsOfResolved } from "../../src/connection/driver-settings.js";
import type { NodeRedisClient } from "../../src/connection/redis-client.js";
import { queueKeysOf } from "../../src/stores/queue/queue-rows.js";
import { leaseKeyOf } from "../../src/stores/leases/redis-cluster-coordinator.js";
import { revealing } from "../support/application-context.js";

/**
 * #1321: `RedisDriver` — the value `@ClusterStorage({ driver })` takes — and the connection's
 * settings as the driver resolved them (`DriverTimeouts.watchLiveness` in `Milliseconds`) — the only
 * source of the connection's settings (agbossjs/agboss#1324: the environment is none).
 */
const URL = "redis://cache:6379/0";
const resolved = (more: Record<string, unknown> = {}) => ({
  ...{ kind: "redis", url: revealing(URL) },
  ...more,
});

describe("RedisDriver", () => {
  it("is the cluster's driver: the connection and the coordination stores, on the backend redis", () => {
    const driver = RedisDriver({ url: secret("REDIS_URL") });

    expect(driver.role).toBe(StorageRole.Cluster);
    expect(driver.backend).toBe("redis");
    expect(driver.describes).toBe("redis");
    expect(driver.providers).toEqual([RedisConnection, ...REDIS_COORDINATION_STORES]);
    expect(driver.settings.kind).toBe("redis");
  });

  it("carries its options and the watch's liveness as a duration, none it was not given", () => {
    const plain = RedisDriver({ url: secret("REDIS_URL") });
    const full = RedisDriver({
      url: secret("REDIS_URL"),
      keyPrefix: "app:",
      durabilityOptOut: RedisDurabilityOptOut.AcknowledgedWritesMayBeLost,
      timeouts: { watchLiveness: sec(20) },
    });

    expect(Object.keys(plain.settings).sort()).toEqual(["kind", "url"]);
    expect(full.settings).toMatchObject({
      keyPrefix: "app:",
      durabilityOptOut: "acknowledged-writes-may-be-lost",
      watchLiveness: 20_000,
    });
  });
});

describe("RedisDriver key prefix from the environment", () => {
  it("takes env(…) like the url's secret: described by its variable, carried as the reference, a name as it is", () => {
    const driver = RedisDriver({ url: secret("REDIS_URL"), keyPrefix: env("REDIS_KEY_PREFIX") });

    expect(driver.describes).toBe("redis (key prefix from REDIS_KEY_PREFIX)");
    expect(driver.settings).toMatchObject({ kind: "redis", keyPrefix: env("REDIS_KEY_PREFIX") });
    expect(RedisDriver({ url: secret("REDIS_URL"), keyPrefix: "app:" }).describes).toBe("redis");
  });

  it("is the name the core resolved at start that the connection builds its keys from", () => {
    const connection = new RedisConnection(settingsOfResolved(resolved({ keyPrefix: "billing:" })));

    expect(connection.keyPrefix).toBe("billing:");
    expect(leaseKeyOf(connection.keyPrefix, "t", "e")).toBe(
      `billing:lease:${JSON.stringify(["t", "e"])}`,
    );
    expect(queueKeysOf(connection.keyPrefix).byTime).toBe("billing:children-queued-by-time");
  });

  it("is refused when the environment gave an empty or unresolved one", () => {
    expect(() => settingsOfResolved(resolved({ keyPrefix: "" }))).toThrow(/keyPrefix is empty/);
    expect(() => settingsOfResolved(resolved({ keyPrefix: env("REDIS_KEY_PREFIX") }))).toThrow(
      RedisSettingsError,
    );
  });
});

describe("the settings a driver resolved", () => {
  it("are the connection's: the revealed URL, the prefix, the opt-out, the liveness in whole seconds", () => {
    expect(
      settingsOfResolved(
        resolved({
          keyPrefix: "app:",
          durabilityOptOut: "acknowledged-writes-may-be-lost",
          watchLiveness: 20_000,
        }),
      ),
    ).toStrictEqual({
      url: URL,
      keyPrefix: "app:",
      durabilityOptOut: "acknowledged-writes-may-be-lost",
      watchLivenessSeconds: 20,
    });
    expect(settingsOfResolved(resolved())).toStrictEqual({ url: URL });
  });

  it.each([
    ["a url that is no secret", { url: URL }, /url must be a secret/],
    ["an empty url", { url: revealing("") }, /url is empty/],
    ["an empty key prefix", { keyPrefix: "" }, /keyPrefix is empty/],
    ["a vague opt-out", { durabilityOptOut: "yes" }, /durabilityOptOut must be exactly/],
    ["a liveness under 2 s", { watchLiveness: 1_000 }, /at least 2/],
    ["a fractional liveness", { watchLiveness: 2_500 }, /whole number/],
  ])("%s is a RedisSettingsError", (_, more, message) => {
    expect(() => settingsOfResolved(resolved(more))).toThrow(RedisSettingsError);
    expect(() => settingsOfResolved(resolved(more))).toThrow(message);
  });

  it("another driver's settings are refused", () => {
    expect(() => settingsOfResolved({ kind: "postgres", url: revealing(URL) })).toThrow(
      RedisSettingsError,
    );
  });

  it("make the connection: its url, its prefix and its watch bound are the driver's", () => {
    const connection = new RedisConnection(resolved({ keyPrefix: "app:", watchLiveness: 30_000 }));

    expect(connection.keyPrefix).toBe("app:");
    expect(connection.watchLivenessSeconds).toBe(30);
  });
});

describe("the client of a connection", () => {
  it("is the package's interface, not node-redis's type; the full client is internal", () => {
    expectTypeOf<RedisConnection["client"]>().toEqualTypeOf<RedisClient>();
    expectTypeOf<NodeRedisClient>().toExtend<RedisClient>();
    const connection = new RedisConnection({ url: URL });

    expect(connection.client).toBe(connection.native);
  });
});
