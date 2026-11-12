/**
 * agbossjs/agboss#923 — an instance's stop ends while the Redis server has gone quiet (`docker
 * pause`: sockets open, nothing answered): `RedisConnection.onDestroy` and the child queue's watch
 * close do not wait for the `QUIT` — past a short grace they destroy the socket; a command in
 * flight rejects; nothing is left to reject unhandled when the server comes back.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { RedisConnection } from "../../src/index.js";
import { openQueueWatch } from "../../src/stores/queue/queue-watch.js";
import {
  endsWithin,
  HAS_DOCKER,
  type PausableServer,
  RealClock,
  sleep,
  startRedis,
  watchUnhandled,
} from "../support/pause.js";

/** Longer than the close's grace, far shorter than a stop's timeout. */
const MARGIN_MS = 4000;

let server: PausableServer;
beforeAll(async () => {
  server = await startRedis();
}, 120_000);
afterEach(() => {
  server.unpause();
});
afterAll(() => {
  server.remove();
});

describe.skipIf(!HAS_DOCKER)("#923: onDestroy against a paused Redis", () => {
  it("idle: onDestroy returns, the socket is destroyed, no unhandled rejection after the unpause", async () => {
    const unhandled = watchUnhandled();
    const connection = new RedisConnection({ url: server.url }, new RealClock());
    await connection.onInit();
    server.pause();
    await sleep(500);

    const outcome = await endsWithin(connection.onDestroy(), MARGIN_MS);
    const stillOpen = connection.client.isOpen;
    server.unpause();
    await sleep(1000);
    unhandled.stop();

    expect(outcome).toBe("returned");
    expect(stillOpen).toBe(false);
    expect(unhandled.seen).toEqual([]);
  });

  it("with a command in flight (a running execution's call): onDestroy returns, the command rejects", async () => {
    const unhandled = watchUnhandled();
    const connection = new RedisConnection({ url: server.url }, new RealClock());
    await connection.onInit();
    server.pause();
    await sleep(500);
    const inFlight = connection.client.get("fix-923-key");
    const failed = inFlight.then(
      () => "answered",
      () => "rejected",
    );

    const outcome = await endsWithin(connection.onDestroy(), MARGIN_MS);
    server.unpause();
    await sleep(1000);
    unhandled.stop();

    expect(outcome).toBe("returned");
    expect(await failed).toBe("rejected");
    expect(unhandled.seen).toEqual([]);
  });

  it("the child queue's watch (its subscriber client) closes too", async () => {
    const unhandled = watchUnhandled();
    const connection = new RedisConnection({ url: server.url }, new RealClock());
    await connection.onInit();
    const subscriber = connection.subscriber();
    const watch = await openQueueWatch(
      subscriber,
      "fix-923-channel",
      () => undefined,
      connection.clock,
    );
    server.pause();
    await sleep(500);

    const outcome = await endsWithin(watch.close(), MARGIN_MS);
    const stillOpen = subscriber.isOpen;
    const destroyed = await endsWithin(connection.onDestroy(), MARGIN_MS);
    server.unpause();
    await sleep(1000);
    unhandled.stop();

    expect(outcome).toBe("returned");
    expect(stillOpen).toBe(false);
    expect(destroyed).toBe("returned");
    expect(unhandled.seen).toEqual([]);
  });
});
