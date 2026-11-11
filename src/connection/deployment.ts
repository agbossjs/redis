import { RedisDeploymentError } from "../errors.js";

/**
 * The deployment the coordination stores rest on (agbossjs/agboss#693 AC4): one durable primary.
 * Redis replicates asynchronously: a write the primary acknowledged may not have reached a replica
 * when that replica is promoted (Sentinel, a cluster failover, an operator's `REPLICAOF NO ONE`).
 * The promoted server then hands out a lease epoch that was already granted — two holders with one
 * fencing token. `WAIT` does not close it (a write whose `WAIT` timed out is still applied on the
 * primary, and a failover may promote a replica that missed it), so nothing here makes a failover
 * safe: the stores run on a primary, never on a replica or a cluster, and the operator runs no
 * automatic failover. What the client can see is checked at start (`INFO replication`, `INFO
 * cluster`); a Sentinel watching the primary cannot be seen from it — the README states that.
 */

/** `INFO <section>`: the server's reply text. */
export type InfoOf = (section: string) => Promise<string>;

/** The `field:value` lines of an `INFO` reply. */
export function infoFieldsOf(reply: string): Readonly<Record<string, string>> {
  const fields: Record<string, string> = {};
  for (const line of reply.split(/\r?\n/u)) {
    const at = line.indexOf(":");
    if (at > 0 && !line.startsWith("#")) fields[line.slice(0, at)] = line.slice(at + 1).trim();
  }
  return fields;
}

/** Each way `replication` and `cluster` (their `INFO` fields) fall short of one primary. */
export function deploymentProblemsOf(
  replication: Readonly<Record<string, string>>,
  cluster: Readonly<Record<string, string>>,
): string[] {
  const problems: string[] = [];
  const role = replication.role;
  if (role !== "master")
    problems.push(
      `the server's role is ${role ?? "unknown"}: the stores write their leases on the primary only — connect to the primary`,
    );
  if (cluster.cluster_enabled !== "0")
    problems.push(
      `cluster mode is ${cluster.cluster_enabled === "1" ? "enabled" : "unknown"}: a cluster fails over automatically to an asynchronous replica, which can hand an acknowledged lease epoch out again — run one primary without automatic failover`,
    );
  return problems;
}

/**
 * What the server says of its deployment (agbossjs/agboss#891: a query, it never throws): its
 * replication `role` and whether cluster mode is on, as `INFO` gives them (`undefined` when not
 * given), and each way it falls short of one primary — empty on a supported server.
 */
export interface RedisTopology {
  /** `INFO replication`'s `role`: `master` on a primary, `slave` on a replica. */
  readonly role: string | undefined;
  /** `INFO cluster`'s `cluster_enabled` is `1`. */
  readonly isClusterEnabled: boolean;
  /** Each way it falls short of one primary; a refused `INFO` is one too. Empty when supported. */
  readonly problems: readonly string[];
}

/** The topology of the server `info` asks; a refused `INFO` is a problem, never a pass. */
export async function topologyOfServer(info: InfoOf): Promise<RedisTopology> {
  try {
    const [replication, cluster] = await Promise.all([info("replication"), info("cluster")]);
    const [replicationFields, clusterFields] = [infoFieldsOf(replication), infoFieldsOf(cluster)];
    return {
      role: replicationFields.role,
      isClusterEnabled: clusterFields.cluster_enabled === "1",
      problems: deploymentProblemsOf(replicationFields, clusterFields),
    };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return {
      role: undefined,
      isClusterEnabled: false,
      problems: [
        `INFO replication / cluster failed (${reason}): the deployment cannot be verified — allow INFO for the stores' user`,
      ],
    };
  }
}

/** The start check's verdict on the topology: no opt-out — a replica or a cluster is refused. */
export function requireOnePrimary(topology: RedisTopology): void {
  if (topology.problems.length > 0) throw new RedisDeploymentError({ problems: topology.problems });
}
