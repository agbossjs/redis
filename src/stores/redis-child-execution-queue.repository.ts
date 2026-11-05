import {
  ApplicationContext,
  ChildExecutionQueueRepository,
  Clock,
  ExecutionRecordStatus,
  Injectable,
  type ChildExecutionEnd,
  type ChildExecutionQueueDepth,
  type ChildExecutionQueueWatch,
  type QueuedChildExecution,
} from "@agboss/core";
import { z } from "zod";
import { RedisConnection } from "../connection/redis-connection.js";
import { keyOf, runScript } from "../connection/scripts.js";
import {
  CLAIM,
  COMPLETE,
  DELETE_TREE,
  DEPTH,
  QUEUED_AT_DIGITS,
  SAVE,
} from "./queue/queue-scripts.js";
import { openQueueWatch } from "./queue/queue-watch.js";

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

/** A queue member's `queuedAt`: its time part shifted back. */
const queuedAtOf = (member: string): Date =>
  new Date(Number(member.slice(0, QUEUED_AT_DIGITS)) - 8.64e15);

/** The depth script's reply: the queued count, the running count, the oldest queued member. */
const DepthReply = z.tuple([z.number().int(), z.number().int()]).rest(z.string().nullable());

/**
 * `ChildExecutionQueueRepository` on Redis (agbossjs/agboss#693): a child is one hash, the queued
 * ones one sorted set (the deepest first, then the longest waiting), a tree's children one set.
 * Every operation that decides is one Lua script (`queue/queue-scripts.ts`): a save or a requeue
 * compares the stored status (and claim) and writes, a claim takes the first member off the queue
 * and marks its row running — so of two instances exactly one claims a child — and a completion
 * matches this instance's running row. Times are the framework `Clock`'s. On any backend beside
 * the leases (#526). The depth (agbossjs/agboss#485) is one script over two more keys the others
 * keep: the queued members by time alone and the running rows. The watch (agbossjs/agboss#777) is a
 * subscription to the channel every save publishes on, one connection of its own per watch.
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
      [
        ...[this.#rowKey(child.tenantId, child.executionId), this.#queueKey()],
        ...[this.#treeKey(child), this.#queuedByTimeKey(), this.#runningKey()],
      ],
      [
        ...[id, `${queuedAtText(child.queuedAt)}${id}`, String(-child.depth)],
        child.claimedAt === undefined ? "" : String(child.claimedAt.getTime()),
        this.#queuedChannel(),
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
      [this.#queueKey(), this.#queuedByTimeKey(), this.#runningKey()],
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
      [this.#rowKey(tenantId, executionId), this.#runningKey()],
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
      [
        ...[this.#treeKey({ tenantId, rootExecutionId }), this.#queueKey()],
        ...[this.#queuedByTimeKey(), this.#runningKey()],
      ],
      [`${this.connection.keyPrefix}child:`],
    );
  }

  async findQueueDepth(): Promise<ChildExecutionQueueDepth> {
    const reply = await runScript(
      this.connection.client,
      DEPTH,
      [this.#queueKey(), this.#queuedByTimeKey(), this.#runningKey()],
      [],
    );
    const [queued, running, oldest] = DepthReply.parse(reply);
    return {
      queued,
      running,
      oldestQueuedAt: oldest === undefined || oldest === null ? undefined : queuedAtOf(oldest),
    };
  }

  /**
   * Wakes `onQueued` whenever any instance queues a child — new, or queued again — on this key
   * prefix (agbossjs/agboss#777): a subscription on a connection of its own to the channel the save
   * script publishes on. Idle on an empty queue: the server pushes, nothing is polled. A dropped
   * connection reconnects (1 s, doubling, at most 30 s apart), subscribes again and wakes
   * `onQueued` once when back — a message sent while it was down is lost (pub/sub keeps nothing),
   * so that wake-up stands for it, and the core's sweep stays the floor. Rejects when the server
   * does not answer: the core opens it again at its next sweep.
   */
  override watchQueued(onQueued: () => void): Promise<ChildExecutionQueueWatch> {
    return openQueueWatch(this.connection.subscriber(), this.#queuedChannel(), onQueued);
  }

  #queuedChannel(): string {
    return `${this.connection.keyPrefix}child-queued`;
  }

  #rowKey(tenantId: string, executionId: string): string {
    return keyOf(this.connection.keyPrefix, "child", tenantId, executionId);
  }

  #queueKey(): string {
    return `${this.connection.keyPrefix}children-queued`;
  }

  #queuedByTimeKey(): string {
    return `${this.connection.keyPrefix}children-queued-by-time`;
  }

  #runningKey(): string {
    return `${this.connection.keyPrefix}children-running`;
  }

  #treeKey(tree: Pick<QueuedChildExecution, "tenantId" | "rootExecutionId">): string {
    return keyOf(this.connection.keyPrefix, "children-of", tree.tenantId, tree.rootExecutionId);
  }
}

/** The row's fields without the queue member it keeps for itself. */
function withoutMember(fields: Readonly<Record<string, string>>): Record<string, string> {
  return Object.fromEntries(Object.entries(fields).filter(([name]) => name !== "member"));
}
