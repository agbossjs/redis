import { describe, expect, it } from "vitest";
import { RedisDeploymentError } from "../../src/index.js";
import {
  deploymentProblemsOf,
  infoFieldsOf,
  requireOnePrimary,
  topologyOfServer,
  type InfoOf,
} from "../../src/connection/deployment.js";

/**
 * agbossjs/agboss#693 AC4 — one durable primary: the start check refuses a replica (the leases are
 * written on the primary only) and a cluster (it fails over automatically to an asynchronous
 * replica, which can grant an acknowledged epoch again), and a server whose INFO it cannot read.
 */
const PRIMARY = "# Replication\r\nrole:master\r\nconnected_slaves:0\r\n";
const STANDALONE = "# Cluster\r\ncluster_enabled:0\r\n";

const infoOf =
  (replication: string, cluster: string): InfoOf =>
  async (section) =>
    section === "replication" ? replication : cluster;

describe("the deployment check: one primary", () => {
  it("reads the field:value lines of an INFO reply, past its section headers", () => {
    expect(infoFieldsOf(PRIMARY)).toEqual({ role: "master", connected_slaves: "0" });
    expect(infoFieldsOf("# Cluster\ncluster_enabled:1\n\nbad line\n")).toEqual({
      cluster_enabled: "1",
    });
  });

  it("AC4: a standalone primary passes — its topology a report: the role, no cluster, no problem", async () => {
    const topology = await topologyOfServer(infoOf(PRIMARY, STANDALONE));

    expect(topology).toEqual({ role: "master", isClusterEnabled: false, problems: [] });
    expect(() => {
      requireOnePrimary(topology);
    }).not.toThrow();
  });

  it("AC4: topology() is a query: a replica in a cluster is reported, never thrown", async () => {
    const topology = await topologyOfServer(
      infoOf("role:slave\r\n", "# Cluster\r\ncluster_enabled:1\r\n"),
    );

    expect(topology.role).toBe("slave");
    expect(topology.isClusterEnabled).toBe(true);
    expect(topology.problems).toHaveLength(2);
  });

  it("a replica is refused: the leases are written on the primary only", () => {
    expect(deploymentProblemsOf({ role: "slave" }, { cluster_enabled: "0" })).toEqual([
      expect.stringMatching(/^the server's role is slave: .*connect to the primary$/u),
    ]);
  });

  it("a cluster is refused: it fails over automatically to an asynchronous replica", () => {
    expect(deploymentProblemsOf({ role: "master" }, { cluster_enabled: "1" })).toEqual([
      expect.stringMatching(
        /^cluster mode is enabled: .*hand an acknowledged lease epoch out again — run one primary without automatic failover$/u,
      ),
    ]);
  });

  it("fields the server does not report are problems, never a pass", () => {
    expect(deploymentProblemsOf({}, {})).toEqual([
      expect.stringMatching(/^the server's role is unknown/u),
      expect.stringMatching(/^cluster mode is unknown/u),
    ]);
  });

  it("an INFO the server refuses cannot be verified: a problem", async () => {
    const refusing: InfoOf = async () => {
      throw new Error("NOPERM this user has no permissions to run the 'info' command");
    };
    expect(await topologyOfServer(refusing)).toEqual({
      role: undefined,
      isClusterEnabled: false,
      problems: [
        expect.stringMatching(/^INFO replication \/ cluster failed \(NOPERM .*allow INFO/u),
      ],
    });
  });

  it("AC4: problems are RedisDeploymentError ({ problems }), with no opt-out", () => {
    let thrown: unknown;
    try {
      requireOnePrimary({
        role: "slave",
        isClusterEnabled: false,
        problems: ["the server's role is slave"],
      });
    } catch (error) {
      thrown = error;
    }
    if (!(thrown instanceof RedisDeploymentError)) throw new Error("expected the named error");
    expect(thrown.problems).toEqual(["the server's role is slave"]);
    expect(thrown.code).toBe("redis.deployment-unsupported");
    expect(thrown.message).toMatch(/^the Redis stores need one durable primary — /u);
  });
});
