/**
 * `RedisConnection` against a real Redis (CI: `redis:7 --appendonly yes --appendfsync always`,
 * and a `redis:7` with the defaults). Locally, without `AGBOSS_REDIS_TEST_URL` /
 * `AGBOSS_REDIS_WEAK_TEST_URL`, these are skipped (the global setup prints how to run them); in
 * CI a missing URL fails the run.
 */
import { createClient } from "@redis/client";
import { afterAll, describe, expect, it } from "vitest";
import { RedisConnection, RedisDurabilityError, RedisDurabilityOptOut } from "../../src/index.js";
import { DURABLE_URL, WEAK_URL } from "../support/server.js";

const SKIPPED =
  "(skipped: AGBOSS_REDIS_TEST_URL is not set — runs in CI on redis:7 --appendonly yes --appendfsync always)";
const WEAK_SKIPPED =
  "(skipped: AGBOSS_REDIS_WEAK_TEST_URL is not set — runs in CI on a redis:7 with the defaults)";

/** `work` with a connection of `url` built from settings, closed after. */
async function withConnection<TResult>(
  connection: RedisConnection,
  work: (connection: RedisConnection) => Promise<TResult>,
): Promise<TResult> {
  try {
    return await work(connection);
  } finally {
    await connection.onDestroy();
  }
}

describe.skipIf(DURABLE_URL === "")(
  `RedisConnection on a durable Redis ${DURABLE_URL === "" ? SKIPPED : ""}`,
  () => {
    it("the start check passes: appendonly yes, appendfsync always, nothing opted out", async () => {
      await withConnection(new RedisConnection({ url: DURABLE_URL }), async (connection) => {
        await connection.onInit();

        expect(connection.client.isReady).toBe(true);
        expect(await connection.durability()).toEqual({ problems: [], optedOut: false });
        await expect(connection.ping()).resolves.toBeUndefined();
      });
    });

    it("onDestroy closes the client", async () => {
      const connection = new RedisConnection({ url: DURABLE_URL });
      await connection.onInit();

      await connection.onDestroy();
      expect(connection.client.isOpen).toBe(false);
    });
  },
);

describe.skipIf(WEAK_URL === "")(
  `RedisConnection on a Redis with the defaults ${WEAK_URL === "" ? WEAK_SKIPPED : ""}`,
  () => {
    afterAll(async () => {
      // the fsync-only case below turns the AOF on: back to the defaults for any later run
      const admin = createClient({ url: WEAK_URL });
      await admin.connect();
      await admin.configSet({ appendonly: "no", appendfsync: "everysec" });
      await admin.close();
    });

    it("the start check refuses it with RedisDurabilityError naming both settings", async () => {
      const connection = new RedisConnection({ url: WEAK_URL });
      const failure: unknown = await connection.onInit().then(
        () => undefined,
        (error: unknown) => error,
      );

      if (!(failure instanceof RedisDurabilityError)) throw new Error("expected the named error");
      expect(failure.problems.map((problem) => problem.split(":")[0])).toEqual([
        "appendonly is no",
        "appendfsync is everysec",
      ]);
      expect(connection.client.isOpen).toBe(false);
    });

    it("the opt-out naming the lost guarantee starts it, and reports what is lost", async () => {
      const connection = new RedisConnection({
        url: WEAK_URL,
        durabilityOptOut: RedisDurabilityOptOut.AcknowledgedWritesMayBeLost,
      });

      await withConnection(connection, async () => {
        await connection.onInit();

        const durability = await connection.durability();
        expect(durability.optedOut).toBe(true);
        expect(durability.problems).toHaveLength(2);
      });
    });

    it("appendonly yes with appendfsync everysec is still refused: only always keeps every write", async () => {
      const admin = createClient({ url: WEAK_URL });
      await admin.connect();
      await admin.configSet({ appendonly: "yes", appendfsync: "everysec" });
      await admin.close();

      const connection = new RedisConnection({ url: WEAK_URL });
      await expect(connection.onInit()).rejects.toThrow(
        /can lose an acknowledged write — appendfsync is everysec: /,
      );
    });
  },
);
