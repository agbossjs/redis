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
  static override readonly code: string = "redis.settings-invalid";
  override name = "RedisSettingsError";
}

/**
 * The server is not one primary (agbossjs/agboss#693 AC4): a replica, a cluster, or a server whose
 * `INFO` cannot be read. A failover to an asynchronous replica can hand an acknowledged lease epoch
 * out again; no opt-out — run one durable primary without automatic failover.
 */
export class RedisDeploymentError extends AGBossError {
  static override readonly code: string = "redis.deployment-unsupported";
  override name = "RedisDeploymentError";
  /** Each way the server falls short of one primary. */
  readonly problems: readonly string[];

  constructor(problems: readonly string[]) {
    super(`the Redis stores need one durable primary — ${problems.join("; ")}`);
    this.problems = problems;
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
  static override readonly code: string = "redis.durability-insufficient";
  override name = "RedisDurabilityError";
  /** Each setting found short, with what it loses and what to set. */
  readonly problems: readonly string[];

  constructor(problems: readonly string[]) {
    super(
      `the Redis server can lose an acknowledged write — ${problems.join("; ")}. Set them on the server, or opt out knowingly: redisDurabilityOptOut: "acknowledged-writes-may-be-lost"`,
    );
    this.problems = problems;
  }
}
