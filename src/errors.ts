import { AGBossError } from "@agboss/core";

/**
 * The errors of `@agboss/redis`: each an `AGBossError` with a stable `code`, so an operator's
 * start-up script and a test tell them apart. A store's own failure (a lost connection, a script
 * error) is the client's error, rethrown as it is: the operation rejects, the core's hand-over
 * rules apply.
 */

/**
 * The environment does not give what the Redis stores need: `redisUrl` (a `Secret` holding a
 * `redis://` or `rediss://` URL), and when set, `redisDurabilityOptOut` (exactly
 * `acknowledged-writes-may-be-lost`). The URL itself is never printed.
 */
export class RedisSettingsError extends AGBossError {
  static override readonly code = "redis.settings-invalid" as const;
  override name = "RedisSettingsError";
}

/** What a start check's error is made of (agbossjs/agboss#891): the problems it found. */
export interface RedisProblemsOptions {
  /** Each way the server falls short, with what it loses and what to set. */
  readonly problems: readonly string[];
}

/**
 * The server is not one primary (agbossjs/agboss#693 AC4): a replica, a cluster, or a server whose
 * `INFO` cannot be read. A failover to an asynchronous replica can hand an acknowledged lease epoch
 * out again; no opt-out — run one durable primary without automatic failover.
 */
export class RedisDeploymentError extends AGBossError {
  static override readonly code = "redis.deployment-unsupported" as const;
  override name = "RedisDeploymentError";
  /** Each way the server falls short of one primary. */
  readonly problems: readonly string[];

  constructor(options: RedisProblemsOptions) {
    super(`the Redis stores need one durable primary — ${options.problems.join("; ")}`);
    this.problems = options.problems;
  }
}

/** What `RedisLeaseKeyConflictError` takes: the execution the two stores disagree about. */
export interface RedisLeaseKeyConflictErrorOptions {
  readonly tenantId: string;
  readonly executionId: string;
  readonly cause?: unknown;
}

/**
 * The Redis lease store holds a lease for an execution that the id store just handed out as new
 * (agbossjs/agboss#923): the two stores belong to different deployments or databases — a database
 * was emptied or replaced and this Redis was not, or two applications share one database or one
 * Redis. Its lease key is a retired or live lease of another execution of the same id, which no
 * take of the new one would ever get (a retired lease is never taken again): the operation fails
 * here instead of waiting for it. Give each application database its own `redisKeyPrefix`, or
 * empty the keys of the discarded one. Only the id is named, never the key's content.
 */
export class RedisLeaseKeyConflictError extends AGBossError {
  static override readonly code = "redis.lease-key-conflict" as const;
  override name = "RedisLeaseKeyConflictError";
  readonly tenantId: string;
  readonly executionId: string;

  constructor(options: RedisLeaseKeyConflictErrorOptions) {
    const { tenantId, executionId, cause } = options;
    super(
      `the Redis lease store holds a lease for execution ${executionId} (tenant ${tenantId}) that the id store just handed out as new — the two stores belong to different deployments or databases; give each its own redisKeyPrefix (or empty the Redis keys of the discarded database)`,
      { cause },
    );
    this.tenantId = tenantId;
    this.executionId = executionId;
  }
}

/**
 * The server does not keep an acknowledged write: `appendonly` is not `yes`, `appendfsync` is not
 * `always`, `no-appendfsync-on-rewrite` is not `no`, `maxmemory-policy` is not `noeviction`, or the
 * settings cannot be read (`CONFIG GET` disabled). A lease
 * acknowledged and then lost lets a second worker take a tree the first still moves. The
 * application does not start — set both on the server, or set `redisDurabilityOptOut:
 * "acknowledged-writes-may-be-lost"` to accept that loss knowingly.
 */
export class RedisDurabilityError extends AGBossError {
  static override readonly code = "redis.durability-insufficient" as const;
  override name = "RedisDurabilityError";
  /** Each setting found short, with what it loses and what to set. */
  readonly problems: readonly string[];

  constructor(options: RedisProblemsOptions) {
    super(
      `the Redis server can lose an acknowledged write — ${options.problems.join("; ")}. Set them on the server, or opt out knowingly: redisDurabilityOptOut: "acknowledged-writes-may-be-lost"`,
    );
    this.problems = options.problems;
  }
}
