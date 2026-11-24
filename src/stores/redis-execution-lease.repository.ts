import {
  ApplicationContext,
  EXECUTION_ID_STORE,
  Injectable,
  StoreClock,
  type ExecutionIdentity,
  type ExecutionIdStore,
  type StoreDescriptor,
} from "@agboss/core";
import { ClusterExecutionLeaseRepository } from "@agboss/core/stores";
import { RedisLeaseKeyConflictError } from "../errors.js";
import { RedisConnection } from "../connection/redis-connection.js";
import { RedisClusterCoordinator, leaseKeyOf } from "./leases/redis-cluster-coordinator.js";

/**
 * The execution lease store on Redis for a `@ClusterStorage` (agbossjs/agboss#693, #1321e, D6): a
 * `ClusterExecutionLeaseRepository` whose cluster is `RedisClusterCoordinator`, beside the
 * database's lease store the application gives under `EXECUTION_ID_STORE`.
 *
 * **Who decides what.** Redis decides liveness — who holds a tree's lease and until when, by the
 * server's own `TIME`, one Lua script per operation (`leases/lease-scripts.ts`), so of two
 * instances exactly one takes a free lease and a renewal never wins against a takeover. The
 * **database's lease row is the authority** for the token, the stop mark, the external pause and
 * its fence, and the fencing stores check that row in their own transaction:
 *
 * - a take (`acquire`, `reclaim`) is written into the row before it is handed out; a row ahead of
 *   Redis's counter (Redis lost its keys: a flush, an old snapshot) gives the lease back, raises the
 *   counter past the row's token (`raiseEpoch`) and asks again — a few times — then fails closed
 *   with `StoreError.ClusterLeaseBehind`;
 * - a release or a retire is written to the row before the key changes;
 * - a mark (cancel, stop, pause, unpause) is written to the row, with its status-history row, and
 *   only then pushed to Redis as a cache and a Pub/Sub signal that never lowers what it holds; every
 *   read of a mark is the row's, never Redis's.
 *
 * Epochs only grow: a lease key is never deleted nor expired (also none on a paused tree's
 * release), and the connection refuses a server that may evict keys.
 *
 * **Coordination only** (`static store = { backend: "redis" }`): the execution ids it hands out
 * (agbossjs/agboss#591) and the marks live in the store the application gives under
 * `EXECUTION_ID_STORE` (its PostgreSQL or MongoDB lease store, created by the container under that
 * token only), never in Redis:
 *
 * ```ts
 * @ClusterStorage({ driver: RedisDriver({ url: secret("REDIS_URL") }) })
 * ```
 */
@Injectable({ deps: [RedisConnection, StoreClock, ApplicationContext, EXECUTION_ID_STORE] })
export class RedisExecutionLeaseRepository extends ClusterExecutionLeaseRepository {
  /** Its own backend: no fencing store of another one may be listed beside it (#526). */
  static override readonly store: StoreDescriptor = { backend: "redis" };

  constructor(
    private readonly connection: RedisConnection,
    clock: StoreClock,
    applicationContext: ApplicationContext,
    executionIds: ExecutionIdStore,
  ) {
    super(new RedisClusterCoordinator(connection, clock, applicationContext), executionIds);
  }

  /** Kept by the database under `EXECUTION_ID_STORE`, never in Redis (#527, #891). */
  override async claimExecutionId(identity: ExecutionIdentity): Promise<boolean> {
    const claimed = await super.claimExecutionId(identity);
    // an id handed out as new has no lease yet: a key of it is another database's (#923)
    if (claimed && (await this.#hasLeaseKey(identity.tenantId, identity.executionId)))
      throw new RedisLeaseKeyConflictError(identity);
    return claimed;
  }

  async #hasLeaseKey(tenantId: string, executionId: string): Promise<boolean> {
    const key = leaseKeyOf(this.connection.keyPrefix, tenantId, executionId);
    return (await this.connection.client.exists(key)) > 0;
  }
}
