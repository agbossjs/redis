import { ExecutionRecordStatus, type QueuedChildExecution } from "@agboss/core";
import { StoreError } from "@agboss/core/stores";
import { VirtualClock } from "@agboss/core/testing";
import { describe, expect, it } from "vitest";
import { RedisChildExecutionQueueRepository, RedisRateLimitRepository } from "../../src/index.js";
import { TestApplicationContext } from "../support/application-context.js";
import { RecordingLogger } from "../support/recording-logger.js";
import { scriptedConnection } from "../support/scripted-connection.js";

/**
 * A time the stores take (a rate-limit pause's end, a queued child's `queuedAt` and `claimedAt`) is
 * checked before anything is sent: an Invalid Date would reach a script as `NaN` and be kept as a
 * row nobody can read. Times are kept as milliseconds, never as text, so nothing else to spell.
 */
const INVALID = new Date(Number.NaN);
const VALID = new Date("2026-01-05T09:00:00.000Z");

const childOf = (extra: Partial<QueuedChildExecution>): QueuedChildExecution => ({
  ...{ tenantId: "default", executionId: "child-1", rootExecutionId: "root-1" },
  ...{ parentExecutionId: "root-1", rootWorkflow: "flow", workflow: "child", depth: 2 },
  ...{ status: ExecutionRecordStatus.Queued, run: "{}", queuedAt: VALID },
  ...extra,
});

describe("an Invalid Date a Redis store is handed", () => {
  it("is refused by pauseUntil with the field named, nothing sent; a valid end reaches the script", async () => {
    const { connection, runs } = scriptedConnection(() => 1, { keyPrefix: "billing:" });
    const limits = new RedisRateLimitRepository(
      connection,
      new VirtualClock(new Date(5_000)),
      new TestApplicationContext(),
    );

    await expect(limits.pauseUntil("provider", INVALID)).rejects.toThrow(
      StoreError.UnreadableRecord,
    );
    await expect(limits.pauseUntil("provider", INVALID)).rejects.toMatchObject({
      record: "rate-limit pause",
      fields: "until",
    });
    await expect(limits.pauseUntil("provider", INVALID)).rejects.toMatchObject({
      record: "rate-limit pause",
    });
    expect(runs).toEqual([]);

    await limits.pauseUntil("provider", VALID);
    expect(runs).toHaveLength(1);
    expect(runs[0]?.keys[0]).toMatch(/^billing:rate-limit-pause:/);
    expect(runs[0]?.args[0]).toBe(String(VALID.getTime()));
  });

  it.each([
    ["queuedAt", { queuedAt: INVALID }],
    ["claimedAt", { claimedAt: INVALID }],
  ])(
    "is refused by saveIfAbsent as %s, nothing sent; a valid child is saved",
    async (field, extra) => {
      const { connection, runs } = scriptedConnection(() => 1, { keyPrefix: "billing:" });
      const queue = new RedisChildExecutionQueueRepository(
        connection,
        new VirtualClock(new Date(5_000)),
        new TestApplicationContext(),
        new RecordingLogger(),
      );

      await expect(queue.saveIfAbsent(childOf(extra))).rejects.toThrow(StoreError.UnreadableRecord);
      await expect(queue.saveIfAbsent(childOf(extra))).rejects.toMatchObject({
        record: "queued child",
        fields: field,
      });
      expect(runs).toEqual([]);

      await expect(queue.saveIfAbsent(childOf({ claimedAt: VALID }))).resolves.toBe(true);
      expect(runs).toHaveLength(1);
      expect(runs[0]?.keys.every((key) => key.startsWith("billing:"))).toBe(true);
    },
  );
});

describe("a stored rate-limit pause", () => {
  const limitsOf = (values: Record<string, string>) => {
    const { connection } = scriptedConnection(() => 1, { keyPrefix: "p:", values });
    return new RedisRateLimitRepository(
      connection,
      new VirtualClock(new Date(5_000)),
      new TestApplicationContext(),
    );
  };
  const KEY = `p:rate-limit-pause:${JSON.stringify(["provider"])}`;

  it.each(["", "abc", "NaN", "12.5", "1e3", "2026-01-05T09:00:00.000Z", " 9000"])(
    "that is no whole number of ms (%j) is UnreadableRecord naming the field, never read as not paused",
    async (stored) => {
      const limits = limitsOf({ [KEY]: stored });

      await expect(limits.pausedUntil("provider")).rejects.toThrow(StoreError.UnreadableRecord);
      await expect(limits.pausedUntil("provider")).rejects.toMatchObject({
        record: "rate-limit pause",
        fields: "until",
      });
    },
  );

  it("that is a number reads as its end while ahead, as not paused once past, and none as not paused", async () => {
    await expect(limitsOf({ [KEY]: "9000" }).pausedUntil("provider")).resolves.toEqual(
      new Date(9000),
    );
    await expect(limitsOf({ [KEY]: "5000" }).pausedUntil("provider")).resolves.toBeUndefined();
    await expect(limitsOf({}).pausedUntil("provider")).resolves.toBeUndefined();
  });
});
