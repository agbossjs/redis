import {
  ApplicationContext,
  ChildExecutionQueueRepository,
  ChildPlacement,
  Clock,
  ExecutionRecordStatus,
  Injectable,
  Logger,
  type ChildExecutionEnd,
  type ChildExecutionQueueCounts,
  type ChildExecutionQueueWatch,
  type QueuedChildExecution,
} from "@agboss/core";
import { RedisConnection } from "../connection/redis-connection.js";
import { runScript } from "../connection/scripts.js";
import {
  CLAIM,
  CLAIM_ISOLATED,
  COMPLETE,
  DELETE_TREE,
  DEPTH,
  QUEUED_ISOLATED,
  SAVE,
  WITHDRAW,
} from "./queue/queue-scripts.js";
import {
  childOf,
  DepthReply,
  fieldsOf,
  queueKeysOf,
  queuedAtOf,
  queuedAtText,
  rowsOf,
  type QueueKeys,
} from "./queue/queue-rows.js";
import { LivenessWatch } from "./queue/queue-watch-liveness.js";

/**
 * `ChildExecutionQueueRepository` on Redis (agbossjs/agboss#693): a child is one hash, the queued
 * ones one sorted set (the deepest first, then the longest waiting), a tree's children one set.
 * Every operation that decides is one Lua script (`queue/queue-scripts.ts`): a save or a requeue
 * compares the stored status (and claim) and writes, a claim takes the first member off the queue
 * and marks its row running — so of two instances exactly one claims a child — and a completion
 * matches this instance's running row. Times are the framework `Clock`'s. The depth (agbossjs/agboss#485) is one script over two more keys the others
 * keep: the queued members by time alone and the running rows. The watch (agbossjs/agboss#777) is a
 * subscription to the channel every save publishes on, one connection of its own per watch.
 */
@Injectable({ deps: [RedisConnection, Clock, ApplicationContext, Logger] })
export class RedisChildExecutionQueueRepository extends ChildExecutionQueueRepository {
  constructor(
    private readonly connection: RedisConnection,
    private readonly clock: Clock,
    private readonly applicationContext: ApplicationContext,
    private readonly logger: Logger,
  ) {
    super();
    this.#keys = queueKeysOf(connection.keyPrefix);
  }

  readonly #keys: QueueKeys;

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
      ...(child.placement === undefined ? {} : { placement: child.placement }),
      ...(child.excludeInstanceId === undefined
        ? {}
        : { excludeInstanceId: child.excludeInstanceId }),
    };
    const isIsolated = child.placement === ChildPlacement.IsolatedWorker;
    const saved = await runScript(
      this.connection.client,
      SAVE,
      [
        ...[this.#keys.row(child.tenantId, child.executionId), this.#keys.queue(isIsolated)],
        ...[this.#keys.tree(child), this.#keys.byTime, this.#keys.running],
        this.#keys.queue(!isIsolated),
      ],
      [
        ...[id, `${queuedAtText(child.queuedAt)}${id}`, String(-child.depth)],
        // Stryker disable next-line StringLiteral: a stored claim is a number; any other text is none
        child.claimedAt === undefined ? "" : String(child.claimedAt.getTime()),
        this.#keys.channel,
        ...Object.entries(fields).flat(),
      ],
    );
    return saved === 1;
  }

  async findByTenantIdAndExecutionId(
    tenantId: string,
    executionId: string,
  ): Promise<QueuedChildExecution | undefined> {
    const fields = await this.connection.client.hGetAll(this.#keys.row(tenantId, executionId));
    return Object.keys(fields).length === 0 ? undefined : childOf(fields);
  }

  async claimFirstByStatusQueuedOrderByDepthDesc(): Promise<QueuedChildExecution | undefined> {
    const reply = await runScript(
      this.connection.client,
      CLAIM,
      [this.#keys.queue(false), this.#keys.byTime, this.#keys.running],
      [
        this.#keys.rowPrefix,
        this.applicationContext.instanceId,
        String(this.clock.now().getTime()),
      ],
    );
    return reply === null ? undefined : childOf(fieldsOf(reply));
  }

  async findQueuedIsolatedWorkerChildren(limit: number): Promise<readonly QueuedChildExecution[]> {
    const reply = await runScript(
      this.connection.client,
      QUEUED_ISOLATED,
      [this.#keys.queue(true)],
      [this.#keys.rowPrefix, String(Math.max(0, Math.floor(limit)))],
    );
    return rowsOf(reply);
  }

  async claimIsolatedWorkerByTenantIdAndExecutionId(
    tenantId: string,
    executionId: string,
  ): Promise<QueuedChildExecution | undefined> {
    const reply = await runScript(
      this.connection.client,
      CLAIM_ISOLATED,
      [
        ...[this.#keys.row(tenantId, executionId), this.#keys.queue(true)],
        ...[this.#keys.byTime, this.#keys.running],
      ],
      [this.applicationContext.instanceId, String(this.clock.now().getTime())],
    );
    return reply === null ? undefined : childOf(fieldsOf(reply));
  }

  async withdrawByTenantIdAndExecutionIdIfQueued(
    tenantId: string,
    executionId: string,
  ): Promise<boolean> {
    const stored = await this.findByTenantIdAndExecutionId(tenantId, executionId);
    if (stored === undefined) return false;
    const withdrawn = await runScript(
      this.connection.client,
      WITHDRAW,
      [
        ...[this.#keys.row(tenantId, executionId), this.#keys.queue(false), this.#keys.queue(true)],
        ...[this.#keys.byTime, this.#keys.tree(stored)],
      ],
      [JSON.stringify([tenantId, executionId])],
    );
    return withdrawn === 1;
  }

  async completeByTenantIdAndExecutionId(
    tenantId: string,
    executionId: string,
    end: ChildExecutionEnd,
  ): Promise<boolean> {
    const completed = await runScript(
      this.connection.client,
      COMPLETE,
      [this.#keys.row(tenantId, executionId), this.#keys.running],
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
        ...[this.#keys.tree({ tenantId, rootExecutionId }), this.#keys.queue(false)],
        ...[this.#keys.byTime, this.#keys.running, this.#keys.queue(true)],
      ],
      [this.#keys.rowPrefix],
    );
  }

  async countByStatus(): Promise<ChildExecutionQueueCounts> {
    const reply = await runScript(
      this.connection.client,
      DEPTH,
      [this.#keys.byTime, this.#keys.running],
      // Stryker disable next-line ArrayDeclaration: the depth script reads no ARGV
      [],
    );
    const [queued, running, oldest] = DepthReply.parse(reply);
    return {
      queued,
      running,
      oldestQueuedAt: oldest === null ? undefined : queuedAtOf(oldest),
    };
  }

  /**
   * Wakes `onQueued` whenever any instance queues a child — new, or queued again — on this key
   * prefix (agbossjs/agboss#777): a subscription on a connection of its own to the channel the save
   * script publishes on. Idle on an empty queue: the server pushes, nothing is polled. A dropped
   * connection reconnects (at once, ~5 ms; while the server stays down 2 s, doubling, at most 30 s
   * apart), subscribes again and wakes `onQueued` once when back — a message sent while it was down is lost (pub/sub keeps nothing),
   * so that wake-up stands for it, and the core's sweep stays the floor. A connection that dies
   * silently is noticed within `redisWatchLivenessSeconds` (agbossjs/agboss#789): a warning
   * (`child-queue.watch-connection-lost`), a new subscription and one wake-up. Rejects when the
   * server does not answer: the core opens it again at its next sweep.
   */
  override watchQueued(onQueued: () => void): Promise<ChildExecutionQueueWatch> {
    return LivenessWatch.open({
      subscriber: () => this.connection.subscriber(),
      channel: this.#keys.channel,
      onQueued,
      clock: this.clock,
      livenessSeconds: this.connection.watchLivenessSeconds,
      logger: this.logger,
    });
  }
}
