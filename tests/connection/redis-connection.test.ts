/**
 * `RedisConnection` without a server: the client parses the URL when it is built and connects at
 * `onInit` only, so the settings, the URL and the reconnect strategy are checked here; a start
 * against a port where nothing listens must fail, never hang. The durability check against real
 * servers is in `tests/integration/`.
 */
import { describe, expect, it } from "vitest";
import { RedisConnection, RedisDurabilityOptOut, RedisSettingsError } from "../../src/index.js";
import {
  reconnectDelayOf,
  reconnectStrategyOf,
  START_CONNECT_RETRIES,
} from "../../src/connection/redis-connection.js";
import { revealing, TestApplicationContext } from "../support/application-context.js";

const URL = "redis://cache:6379/0";

/** The error `build` throws; fails the test when it throws none. */
function errorOf(build: () => unknown): unknown {
  try {
    build();
  } catch (error) {
    return error;
  }
  throw new Error("built: it should have failed");
}

describe("RedisConnection: one client per application instance", () => {
  it("is built from the application's environment, not connected until onInit", async () => {
    const connection = new RedisConnection(
      new TestApplicationContext({ redisUrl: revealing(URL) }),
    );

    expect(connection.client.isOpen).toBe(false);
    await connection.onDestroy();
  });

  it("is built from settings by a script or a test, the opt-out among them", async () => {
    const connection = new RedisConnection({
      url: "rediss://cache:6380",
      durabilityOptOut: RedisDurabilityOptOut.AcknowledgedWritesMayBeLost,
    });

    expect(connection.client.isOpen).toBe(false);
    await connection.onDestroy();
  });

  it("closing a client that never connected resolves", async () => {
    const connection = new RedisConnection({ url: URL });

    await expect(connection.onDestroy()).resolves.toBeUndefined();
  });

  it("an environment without redisUrl fails before any client is built", () => {
    expect(() => new RedisConnection(new TestApplicationContext({}))).toThrow(
      /redisUrl is missing/,
    );
  });

  it("an opt-out that does not name the guarantee fails at construction", () => {
    const context = new TestApplicationContext({
      redisUrl: revealing(URL),
      redisDurabilityOptOut: "yes",
    });

    expect(() => new RedisConnection(context)).toThrow(RedisSettingsError);
  });
});

describe("RedisConnection: a URL the client cannot use", () => {
  it.each([
    ["http://cache:6379", /not a valid Redis protocol/],
    ["not a url", /redisUrl is not a usable Redis URL: Invalid URL/],
    ["redis://:pw@cache:notaport", /redisUrl is not a usable Redis URL/],
  ])("%s → RedisSettingsError with the client's reason", (url, message) => {
    const error = errorOf(() => new RedisConnection({ url }));

    expect(error).toBeInstanceOf(RedisSettingsError);
    expect(String(error)).toMatch(message);
  });

  it("the reason never prints the password", () => {
    const error = errorOf(() => new RedisConnection({ url: "redis://:hunter2@cache:notaport" }));

    expect(String(error)).not.toMatch(/hunter2/);
  });
});

describe("the reconnect strategy: a start fails fast, a running instance keeps trying", () => {
  const cause = new Error("connect ECONNREFUSED");

  it("before the first ready: a growing wait, then the cause after the last retry", () => {
    const strategy = reconnectStrategyOf(() => false);

    expect([0, 1, 2, 3, 4].map((retries) => strategy(retries, cause))).toEqual([
      100, 200, 300, 400, 500,
    ]);
    expect(strategy(START_CONNECT_RETRIES, cause)).toBe(cause);
    expect(START_CONNECT_RETRIES).toBe(5);
  });

  it("once ready: retried for as long as it takes, at most 1 s apart", () => {
    const strategy = reconnectStrategyOf(() => true);

    expect(strategy(START_CONNECT_RETRIES, cause)).toBe(600);
    expect(strategy(1000, cause)).toBe(1000);
  });

  it("the wait grows by 100 ms and is capped at 1 s", () => {
    expect([1, 5, 10, 11, 50].map(reconnectDelayOf)).toEqual([100, 500, 1000, 1000, 1000]);
  });
});

describe("RedisConnection when the server does not answer", () => {
  // port 1 on the loopback: nothing listens; the start gives up after its retries
  const UNREACHABLE = "redis://127.0.0.1:1";

  it("onInit rejects with the connection's error and leaves the client closed", async () => {
    const connection = new RedisConnection({ url: UNREACHABLE });

    await expect(connection.onInit()).rejects.toThrow(/ECONNREFUSED/);
    expect(connection.client.isOpen).toBe(false);
    await connection.onDestroy();
  });
});
