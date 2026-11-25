/**
 * agbossjs/agboss#954 — an application's stop against a Redis server gone quiet (`docker pause`):
 * `close({ timeout })` gives up the child workers and the sweep that wait on it, and still no
 * socket to the server is left open — the queue watch's subscriber included (it belongs to a
 * worker the stop abandoned). Sockets are counted by the sockets, not by the clients' `isOpen`.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { seconds } from "@agboss/core/units";
import { createApp } from "@agboss/core";
import { RecordingLogger } from "../support/recording-logger.js";
import { RedisConnection } from "../../src/index.js";
import { LivenessWatch } from "../../src/stores/queue/queue-watch-liveness.js";
import {
  HAS_DOCKER,
  type PausableServer,
  RealClock,
  sleep,
  startRedis,
  trackSockets,
  watchUnhandled,
} from "../support/pause.js";
import { StopApplication } from "../fixtures/stop/stop.application.js";

let server: PausableServer;
beforeAll(async () => {
  if (HAS_DOCKER) server = await startRedis();
}, 120_000);
afterAll(async () => {
  if (HAS_DOCKER) await server.remove();
});

describe.skipIf(!HAS_DOCKER)("#954: close() against a paused Redis leaves no socket open", () => {
  it("an idle application: every socket to the server is destroyed when close() returns", async () => {
    const port = Number(new URL(server.url).port);
    process.env.AGBOSS_STOP_REDIS_URL = server.url;
    process.env.AGBOSS_STOP_SQLITE_PATH = ":memory:";
    const unhandled = watchUnhandled();
    const sockets = trackSockets(port);
    try {
      const app = await createApp(StopApplication, { env: "stop" });
      // paused as the child queue's watch is still opening its subscriber: no worker owns it yet
      await server.pause();
      await sleep(2000);

      await app.close({ timeout: seconds(5) });
      const open = sockets.open();
      await server.unpause();
      await sleep(500);

      expect(open).toBe(0);
      expect(unhandled.seen).toEqual([]);
    } finally {
      sockets.stop();
      unhandled.stop();
      await server.unpause();
    }
  }, 60_000);
});

describe.skipIf(!HAS_DOCKER)("#954: a watch that resubscribes while the connection stops", () => {
  /** A watch on a connection with a 2 s liveness bound, the server then paused until the watch is lost. */
  async function lostWatch(): Promise<{
    readonly connection: RedisConnection;
    readonly sockets: ReturnType<typeof trackSockets>;
    readonly watch: LivenessWatch;
  }> {
    const connection = new RedisConnection(
      { url: server.url, watchLivenessSeconds: 2 },
      new RealClock(),
    );
    await connection.onInit();
    const logger = new RecordingLogger();
    const sockets = trackSockets(Number(new URL(server.url).port));
    const watch = await LivenessWatch.open({
      subscriber: () => connection.subscriber(),
      channel: "i954-channel",
      onQueued: () => undefined,
      clock: new RealClock(),
      livenessSeconds: 2,
      logger,
    });
    await server.pause();
    for (let waited = 0; logger.entries.length === 0 && waited < 10_000; waited += 100) {
      await sleep(100);
    }
    expect(logger.entries.length).toBeGreaterThan(0);
    return { connection, sockets, watch };
  }

  it("the connection stops while the new subscriber connects: its socket is destroyed", async () => {
    const unhandled = watchUnhandled();
    const { connection, sockets } = await lostWatch();
    try {
      await sleep(1500); // past the 1 s pause: the new subscriber is connecting to the quiet server

      await connection.onDestroy();
      await sleep(300);

      expect(sockets.open()).toBe(0);
      expect(unhandled.seen).toEqual([]);
    } finally {
      sockets.stop();
      unhandled.stop();
      await server.unpause();
    }
  }, 60_000);

  it("the connection stops before the pause ends: no new subscriber is handed out, no socket opens", async () => {
    const { connection, sockets } = await lostWatch();
    try {
      await connection.onDestroy();
      await sleep(2500); // past the pause: the watch tries again

      expect(() => connection.subscriber()).toThrow();
      expect(sockets.open()).toBe(0);
    } finally {
      sockets.stop();
      await server.unpause();
    }
  }, 60_000);
});
