/**
 * agbossjs/agboss#777, #954, #1213 — how `RedisConnection` builds and gives up its clients, with no
 * server: a client's reconnect strategy knows whether it was ever ready, the subscriber's waits
 * double to 30 s, the settings' defaults are used only when none is given, and a connection that
 * stops hands out no subscriber and destroys the ones still up — not one its owner already ended.
 */
import { describe, expect, it, vi } from "vitest";
import { RedisConnection } from "../../src/index.js";
import {
  clientOf,
  subscriberReconnectDelayOf,
  subscriberReconnectStrategyOf,
  type RedisClient,
} from "../../src/connection/redis-connection.js";
import { RedisConnectionClosedError } from "../../src/errors.js";

const URL = "redis://127.0.0.1:1";
const CAUSE = new Error("ECONNREFUSED");

/** The strategy node-redis was given for `client`. */
function strategyOf(client: RedisClient): (retries: number, cause: Error) => unknown {
  const strategy = client.options.socket?.reconnectStrategy;
  if (typeof strategy !== "function") throw new Error("the client has no reconnect strategy");
  return strategy;
}

describe("the clients' reconnect strategies", () => {
  it("a client never ready gives up with the cause; once it emitted ready, it keeps trying", () => {
    const client = clientOf(URL);
    expect(strategyOf(client)(5, CAUSE)).toBe(CAUSE);

    client.emit("ready");

    expect(strategyOf(client)(5, CAUSE)).toBe(600);
  });

  it("a subscriber never ready gives up at once; once ready, it waits subscriberReconnectDelayOf", () => {
    const client = clientOf(URL, subscriberReconnectStrategyOf);
    expect(strategyOf(client)(0, CAUSE)).toBe(CAUSE);

    client.emit("ready");

    expect(strategyOf(client)(3, CAUSE)).toBe(8000);
  });

  it("the subscriber's waits: 1 s, doubling, at most 30 s", () => {
    expect([0, 1, 2, 3, 4, 5, 6, 9].map(subscriberReconnectDelayOf)).toEqual([
      1000, 2000, 4000, 8000, 16_000, 30_000, 30_000, 30_000,
    ]);
  });
});

describe("RedisConnection's settings and its subscribers", () => {
  it("the key prefix and the liveness bound: the given ones, else the defaults", async () => {
    const given = new RedisConnection({ url: URL, keyPrefix: "billing:", watchLivenessSeconds: 6 });
    const defaults = new RedisConnection({ url: URL });

    expect([given.keyPrefix, given.watchLivenessSeconds]).toEqual(["billing:", 6]);
    expect([defaults.keyPrefix, defaults.watchLivenessSeconds]).toEqual(["agboss:", 10]);
    await given.onDestroy();
    await defaults.onDestroy();
  });

  it("ping() is the client's PING: on a client that is not connected it rejects", async () => {
    const connection = new RedisConnection({ url: URL });

    await expect(connection.ping()).rejects.toThrow();
    await connection.onDestroy();
  });

  it("a stopped connection destroys the subscribers still up and hands out no other", async () => {
    const connection = new RedisConnection({ url: URL });
    const subscriber = connection.subscriber();
    const destroy = vi.spyOn(subscriber, "destroy");

    await connection.onDestroy();

    expect(destroy).toHaveBeenCalledTimes(1);
    expect(() => connection.subscriber()).toThrow(RedisConnectionClosedError);
  });

  it("a subscriber its owner ended is not destroyed again by the stop", async () => {
    const connection = new RedisConnection({ url: URL });
    const subscriber = connection.subscriber();
    const destroy = vi.spyOn(subscriber, "destroy");

    subscriber.emit("end");
    await connection.onDestroy();

    expect(destroy).not.toHaveBeenCalled();
  });
});
