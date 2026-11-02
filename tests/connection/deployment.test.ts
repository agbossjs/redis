import { describe, expect, it } from "vitest";
import { RedisDeploymentError } from "../../src/index.js";
import {
  deploymentProblemsOf,
  deploymentProblemsOfServer,
  infoFieldsOf,
  requireOnePrimary,
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

  it("a standalone primary passes", async () => {
    expect(await deploymentProblemsOfServer(infoOf(PRIMARY, STANDALONE))).toEqual([]);
    expect(() => {
      requireOnePrimary([]);
    }).not.toThrow();
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
    expect(await deploymentProblemsOfServer(refusing)).toEqual([
      expect.stringMatching(/^INFO replication \/ cluster failed \(NOPERM .*allow INFO/u),
    ]);
  });

  it("problems are RedisDeploymentError, with no opt-out", () => {
    let thrown: unknown;
    try {
      requireOnePrimary(["the server's role is slave"]);
    } catch (error) {
      thrown = error;
    }
    if (!(thrown instanceof RedisDeploymentError)) throw new Error("expected the named error");
    expect(thrown.problems).toEqual(["the server's role is slave"]);
    expect(thrown.code).toBe("redis.deployment-unsupported");
    expect(thrown.message).toMatch(/^the Redis stores need one durable primary — /u);
  });
});
