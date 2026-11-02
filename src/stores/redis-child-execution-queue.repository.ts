import {
  ApplicationContext,
  ChildExecutionQueueRepository,
  Clock,
  ExecutionRecordStatus,
  Injectable,
  type ChildExecutionEnd,
  type QueuedChildExecution,
} from "@agboss/core";
import { z } from "zod";
import { RedisConnection } from "../connection/redis-connection.js";
import { keyOf, runScript } from "../connection/scripts.js";
import { CLAIM, COMPLETE, DELETE_TREE, QUEUED_AT_DIGITS, SAVE } from "./queue/queue-scripts.js";

/** A time as the row keeps it: ms as text. */
const Time = z
  .string()
  .regex(/^-?\d+$/u)
  .transform((text) => new Date(Number(text)));

const Row = z.object({
  tenantId: z.string(),
  executionId: z.string(),
  rootExecutionId: z.string(),
  parentExecutionId: z.string(),
  rootWorkflow: z.string(),
  workflow: z.string(),
  depth: z.string().transform(Number).pipe(z.number().int()),
  status: z.enum(ExecutionRecordStatus),
  run: z.string(),
  queuedAt: Time,
  instanceId: z.string().optional(),
  claimedAt: Time.optional(),
  endedAt: Time.optional(),
  failure: z.string().optional(),
});

/** A row as the contract gives it back. */
const childOf = (fields: Readonly<Record<string, string>>): QueuedChildExecution => {
  const row = Row.parse(fields);
  return {
    ...row,
    instanceId: row.instanceId,
    claimedAt: row.claimedAt,
    endedAt: row.endedAt,
    failure: row.failure,
  };
};

/** A flat `HGETALL` reply (name, value, …) as fields. */
const fieldsOf = (reply: unknown): Record<string, string> => {
  const flat = z.array(z.string()).parse(reply);
  const fields: Record<string, string> = {};
  for (let at = 0; at + 1 < flat.length; at += 2) fields[flat[at] ?? ""] = flat[at + 1] ?? "";
  return fields;
};

/** The queue member's time part: `queuedAt` shifted to be positive, 17 digits — sorts by time. */
const queuedAtText = (queuedAt: Date): string =>
  String(queuedAt.getTime() + 8.64e15).padStart(QUEUED_AT_DIGITS, "0");

/**
 * `ChildExecutionQueueRepository` on Redis (agbossjs/agboss#693): a child is one hash, the queued
 * ones one sorted set (the deepest first, then the longest waiting), a tree's children one set.
 * Every operation that decides is one Lua script (`queue/queue-scripts.ts`): a save or a requeue
 * compares the stored status (and claim) and writes, a claim takes the first member off the queue
 * and marks its row running — so of two instances exactly one claims a child — and a completion
 * matches this instance's running row. Times are the framework `Clock`'s. On any backend beside
 * the leases (#526).
 */
@Injectable({ deps: [RedisConnection, Clock, ApplicationContext] })
export class RedisChildExecutionQueueRepository extends ChildExecutionQueueRepository {
  constructor(
    private readonly connection: RedisConnection,
    private readonly clock: Clock,
    private readonly applicationContext: ApplicationContext,
  ) {
    super();
  }

  ping(): Promise<void> {
    return this.connection.ping();
  }

  async saveIfAbsent(child: QueuedChildExecution): Promise<boolean> {
    const id = JSON.stringify([child.tenantId, child.executionId]);
    const fields = {
      ...{ tenantId: child.tenantId, executionId: child.executionId },
      ...{ rootExecutionId: child.rootExecutionId, parentExecutionId: child.parentExecutionId },
      ...{ rootWorkflow: child.rootWorkflow, workflow: child.workflow },
      ...{ depth: String(child.depth), status: ExecutionRecordStatus.Queued, run: child.run },
      queuedAt: String(child.queuedAt.getTime()),
    };
    const saved = await runScript(
      this.connection.client,
      SAVE,
      [this.#rowKey(child.tenantId, child.executionId), this.#queueKey(), this.#treeKey(child)],
      [
        ...[id, `${queuedAtText(child.queuedAt)}${id}`, String(-child.depth)],
        child.claimedAt === undefined ? "" : String(child.claimedAt.getTime()),
        ...Object.entries(fields).flat(),
      ],
    );
    return saved === 1;
  }

  async findByTenantIdAndExecutionId(
    tenantId: string,
    executionId: string,
  ): Promise<QueuedChildExecution | undefined> {
    const fields = await this.connection.client.hGetAll(this.#rowKey(tenantId, executionId));
    return Object.keys(fields).length === 0 ? undefined : childOf(withoutMember(fields));
  }

  async claimFirstByStatusQueuedOrderByDepthDesc(): Promise<QueuedChildExecution | undefined> {
    const reply = await runScript(
      this.connection.client,
      CLAIM,
      [this.#queueKey()],
      [
        `${this.connection.keyPrefix}child:`,
        this.applicationContext.instanceId,
        String(this.clock.now().getTime()),
      ],
    );
    return reply === null ? undefined : childOf(withoutMember(fieldsOf(reply)));
  }

  async completeByTenantIdAndExecutionId(
    tenantId: string,
    executionId: string,
    end: ChildExecutionEnd,
  ): Promise<boolean> {
    const completed = await runScript(
      this.connection.client,
      COMPLETE,
      [this.#rowKey(tenantId, executionId)],
      [
        ...[this.applicationContext.instanceId, end.status],
        ...[String(this.clock.now().getTime()), end.failure ?? ""],
      ],
    );
    return completed === 1;
  }

  async deleteAllByTenantIdAndRootExecutionId(
    tenantId: string,
    rootExecutionId: string,
  ): Promise<void> {
    await runScript(
      this.connection.client,
      DELETE_TREE,
      [this.#treeKey({ tenantId, rootExecutionId }), this.#queueKey()],
      [`${this.connection.keyPrefix}child:`],
    );
  }

  #rowKey(tenantId: string, executionId: string): string {
    return keyOf(this.connection.keyPrefix, "child", tenantId, executionId);
  }

  #queueKey(): string {
    return `${this.connection.keyPrefix}children-queued`;
  }

  #treeKey(tree: Pick<QueuedChildExecution, "tenantId" | "rootExecutionId">): string {
    return keyOf(this.connection.keyPrefix, "children-of", tree.tenantId, tree.rootExecutionId);
  }
}

/** The row's fields without the queue member it keeps for itself. */
function withoutMember(fields: Readonly<Record<string, string>>): Record<string, string> {
  return Object.fromEntries(Object.entries(fields).filter(([name]) => name !== "member"));
}
