import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { StoreClock, StoreTimeSource } from "@agboss/core";
import { seconds } from "@agboss/core/units";
import { describe, expect, it } from "vitest";
import {
  RedisConnection,
  RedisDurabilityError,
  RedisDurabilityOptOut,
  RedisExecutionLeaseRepository,
} from "../../src/index.js";
import { TestApplicationContext } from "../support/application-context.js";
import { SharedKeptIds } from "../support/redis-store.js";
import { DURABLE_URL } from "../support/server.js";

/**
 * agbossjs/agboss#693 AC3 — what the durability settings keep across a real crash: the server's
 * process killed (`docker kill -s KILL`, no shutdown, no final fsync) and started again from its
 * files. With `appendonly yes` + `appendfsync always` every acknowledged epoch survives and the
 * next take continues from it. The sabotage: the same server with its append-only file turned off
 * (`CONFIG SET appendonly no`) is refused by the start check unless the opt-out names the loss; the
 * opted-out store's epochs are lost in the crash, and the next take grants an epoch that was
 * already granted — two holders of one fencing token. It kills the test server, so it runs on its
 * own (`npm run test:crash`, CI's step after the check): `AGBOSS_REDIS_CRASH_CONTAINER` names the
 * container of `AGBOSS_REDIS_TEST_URL`.
 */
const CONTAINER = process.env.AGBOSS_REDIS_CRASH_CONTAINER ?? "";
const run = promisify(execFile);
const LEASE = seconds(30);
const TREES = 20;

const docker = async (...args: string[]): Promise<void> => {
  await run("docker", args);
};

/** The server killed with SIGKILL and started again; resolves once it answers (and loaded). */
async function crashAndRestart(): Promise<void> {
  await docker("kill", "--signal", "KILL", CONTAINER);
  await docker("start", CONTAINER);
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const probe = new RedisConnection({
      url: DURABLE_URL,
      durabilityOptOut: RedisDurabilityOptOut.AcknowledgedWritesMayBeLost,
    });
    try {
      await probe.onInit();
      // a read answers only once the dataset is loaded (LOADING before)
      await probe.client.get("agboss-crash:probe");
      return;
    } catch {
      // not up yet
    } finally {
      await probe.onDestroy();
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 100);
    });
  }
  throw new Error(`${CONTAINER} did not come back`);
}

/** A started lease store on the server, its kept ids aside. */
async function leasesOn(
  prefix: string,
  optOut?: RedisDurabilityOptOut,
): Promise<{ leases: RedisExecutionLeaseRepository; connection: RedisConnection }> {
  const connection = new RedisConnection({
    url: DURABLE_URL,
    keyPrefix: prefix,
    ...(optOut === undefined ? {} : { durabilityOptOut: optOut }),
  });
  await connection.onInit();
  const application = new TestApplicationContext({}, "instance-1");
  const clock = new StoreClock(StoreTimeSource.Database, { now: () => new Date(0) });
  const leases = new RedisExecutionLeaseRepository(
    connection,
    clock,
    application,
    new SharedKeptIds(),
  );
  return { leases, connection };
}

/** Each tree taken and released `times` times: the epochs granted, by tree. */
async function takeAndRelease(
  leases: RedisExecutionLeaseRepository,
  times: number,
): Promise<number[]> {
  const epochs: number[] = [];
  for (let tree = 0; tree < TREES; tree += 1) {
    let last = 0;
    for (let take = 0; take < times; take += 1) {
      const lease = await leases.acquire("default", `tree-${String(tree)}`, LEASE);
      if (lease === undefined) throw new Error("a released lease is taken again");
      await leases.release(lease);
      last = lease.token;
    }
    epochs.push(last);
  }
  return epochs;
}

describe.skipIf(CONTAINER === "" || DURABLE_URL === "")(
  "agbossjs/agboss#693 AC3: the durability settings across a SIGKILL of the server",
  () => {
    it("appendonly yes + appendfsync always: every acknowledged epoch survives; the next take continues", async () => {
      const prefix = `agboss-crash:durable:${String(Date.now())}:`;
      const before = await leasesOn(prefix);
      const granted = await takeAndRelease(before.leases, 3);
      await before.connection.onDestroy();

      await crashAndRestart();

      const after = await leasesOn(prefix);
      const next = await takeAndRelease(after.leases, 1);
      await after.connection.onDestroy();
      expect(granted).toEqual(Array.from({ length: TREES }, () => 3));
      expect(next).toEqual(Array.from({ length: TREES }, () => 4));
    }, 120_000);

    it("sabotage — the AOF turned off: refused at start; opted out, the crash loses epochs and one is granted twice", async () => {
      const prefix = `agboss-crash:weak:${String(Date.now())}:`;
      const durable = await leasesOn(prefix);
      await takeAndRelease(durable.leases, 1);
      await durable.connection.client.configSet("appendonly", "no");
      await durable.connection.onDestroy();

      const refused: unknown = await leasesOn(prefix).then(
        () => undefined,
        (error: unknown) => error,
      );
      const weak = await leasesOn(prefix, RedisDurabilityOptOut.AcknowledgedWritesMayBeLost);
      const granted = await takeAndRelease(weak.leases, 2);
      await weak.connection.onDestroy();

      // the container starts with --appendonly yes again: the file it loads lacks the writes since
      await crashAndRestart();

      const after = await leasesOn(prefix);
      const regranted = await takeAndRelease(after.leases, 1);
      await after.connection.onDestroy();
      expect(refused).toBeInstanceOf(RedisDurabilityError);
      expect((refused as RedisDurabilityError).problems[0]).toMatch(/^appendonly is no/u);
      expect(granted).toEqual(Array.from({ length: TREES }, () => 3));
      // epoch 2 and 3 were granted before the crash, and epoch 2 is granted again after it
      expect(regranted).toEqual(Array.from({ length: TREES }, () => 2));
    }, 120_000);
  },
);
