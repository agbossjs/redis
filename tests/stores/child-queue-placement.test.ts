import { ChildPlacement, ExecutionRecordStatus, type QueuedChildExecution } from "@agboss/core";
import { describe, expect, it } from "vitest";
import { RedisChildExecutionQueueRepository } from "../../src/index.js";
import {
  CLAIM_ISOLATED,
  QUEUED_ISOLATED,
  SAVE,
  WITHDRAW,
} from "../../src/stores/queue/queue-scripts.js";
import { VirtualClock } from "@agboss/core/testing";
import { TestApplicationContext } from "../support/application-context.js";
import { scriptedConnection, type ScriptRun } from "../support/scripted-connection.js";
import { RecordingLogger } from "../support/recording-logger.js";

/**
 * #1286 on Redis: where a queued child runs. An isolated worker's child is on a queue of its own
 * (never claimed by the general workers), an `OtherWorker` child keeps the instance that must not
 * claim it, and the targeted claim and the withdrawal are one script each. A scripted client: what
 * the scripts send and how their answers are read; the scripts' behaviour on a server is the
 * contract's (`child-execution-queue-placement`).
 */
const PREFIX = "t:";
const QUEUED_AT = new Date("2026-01-05T09:00:00.000Z");

function scripted(reply: (run: ScriptRun) => unknown, stored: Record<string, string> = {}) {
  const { connection, runs } = scriptedConnection(reply, { keyPrefix: PREFIX, stored });
  const store = new RedisChildExecutionQueueRepository(
    connection,
    new VirtualClock(new Date(5_000)),
    new TestApplicationContext("instance-1"),
    new RecordingLogger(),
  );
  return { store, calls: runs };
}

const childOf = (extra: Partial<QueuedChildExecution> = {}): QueuedChildExecution => ({
  ...{ tenantId: "default", executionId: "child-1", rootExecutionId: "root-1" },
  ...{ parentExecutionId: "root-1", rootWorkflow: "flow", workflow: "child", depth: 2 },
  ...{ status: ExecutionRecordStatus.Queued, run: "{}", queuedAt: QUEUED_AT },
  ...extra,
});

/** A row as `HGETALL` answers it: name, value, name, value … */
const flat = (fields: Record<string, string>): string[] => Object.entries(fields).flat();

const ROW = {
  ...{ tenantId: "default", executionId: "child-1", rootExecutionId: "root-1" },
  ...{ parentExecutionId: "root-1", rootWorkflow: "flow", workflow: "child", depth: "2" },
  ...{ status: "running", run: "{}", queuedAt: String(QUEUED_AT.getTime()) },
};

describe("a queued child's placement on Redis", () => {
  it("an isolated worker's child is queued on the queue of its own, the general one named last", async () => {
    const { store, calls } = scripted(() => 1);

    await store.saveIfAbsent(childOf({ placement: ChildPlacement.IsolatedWorker }));
    await store.saveIfAbsent(childOf({ placement: ChildPlacement.AnyWorker }));

    expect(calls.map((call) => call.script)).toEqual([SAVE.sha, SAVE.sha]);
    const [isolated, general] = calls;
    expect(isolated?.keys[1]).toBe(`${PREFIX}children-queued-isolated`);
    expect(isolated?.keys[5]).toBe(`${PREFIX}children-queued`);
    expect(general?.keys[1]).toBe(`${PREFIX}children-queued`);
    expect(general?.keys[5]).toBe(`${PREFIX}children-queued-isolated`);
    expect(isolated?.args).toContain("isolated-worker");
  });

  it("a child that must not be claimed by its launcher keeps that instance in its row", async () => {
    const { store, calls } = scripted(() => 1);

    await store.saveIfAbsent(
      childOf({ placement: ChildPlacement.OtherWorker, excludeInstanceId: "instance-9" }),
    );

    const fields = calls[0]?.args.slice(5) ?? [];
    expect(fields).toEqual(expect.arrayContaining(["excludeInstanceId", "instance-9"]));
    expect(fields).toEqual(expect.arrayContaining(["placement", "other-worker"]));
  });

  it("a child with no placement writes neither field", async () => {
    const { store, calls } = scripted(() => 1);

    await store.saveIfAbsent(childOf());

    const names = (calls[0]?.args.slice(5) ?? []).filter((_, at) => at % 2 === 0);
    expect(names).not.toContain("placement");
    expect(names).not.toContain("excludeInstanceId");
  });

  it("lists the isolated workers' queued children, each read back with its placement and limit", async () => {
    const { store, calls } = scripted(() => [
      flat({ ...ROW, status: "queued", placement: "isolated-worker" }),
    ]);

    const found = await store.findQueuedIsolatedWorkerChildren(3);

    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ executionId: "child-1", placement: "isolated-worker" });
    expect(calls[0]).toEqual({
      script: QUEUED_ISOLATED.sha,
      keys: [`${PREFIX}children-queued-isolated`],
      args: [`${PREFIX}child:`, "3"],
    });
  });

  it("claims one isolated child by its id: running for this instance, or nothing", async () => {
    const replies: unknown[] = [
      flat({ ...ROW, instanceId: "instance-1", claimedAt: "5000", placement: "isolated-worker" }),
      null,
    ];
    const { store, calls } = scripted(() => replies.shift());

    const claimed = await store.claimIsolatedWorkerByTenantIdAndExecutionId("default", "child-1");
    const refused = await store.claimIsolatedWorkerByTenantIdAndExecutionId("default", "child-1");

    expect(claimed).toMatchObject({ instanceId: "instance-1", status: "running" });
    expect(refused).toBeUndefined();
    expect(calls[0]?.script).toBe(CLAIM_ISOLATED.sha);
    expect(calls[0]?.args).toEqual(["instance-1", "5000"]);
  });

  it("withdraws a child that is queued: its row, both queues and its tree's set in one script", async () => {
    const { store, calls } = scripted(() => 1);
    const stored = scripted(() => 1, ROW);

    expect(await stored.store.withdrawByTenantIdAndExecutionIdIfQueued("default", "child-1")).toBe(
      true,
    );
    expect(await store.withdrawByTenantIdAndExecutionIdIfQueued("default", "gone")).toBe(false);

    const [call] = stored.calls;
    expect(call?.script).toBe(WITHDRAW.sha);
    expect(call?.keys.slice(1, 4)).toEqual([
      `${PREFIX}children-queued`,
      `${PREFIX}children-queued-isolated`,
      `${PREFIX}children-queued-by-time`,
    ]);
    expect(call?.args).toEqual([JSON.stringify(["default", "child-1"])]);
    // a child no row is stored for is none to withdraw: no script runs
    expect(calls).toEqual([]);
  });

  it("a withdrawal the script refuses (a claim won) is false", async () => {
    const { store } = scripted(() => 0, ROW);

    expect(await store.withdrawByTenantIdAndExecutionIdIfQueued("default", "child-1")).toBe(false);
  });
});
