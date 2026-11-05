import { storeConformance } from "@agboss/core/testing/contracts";
import { afterAll } from "vitest";
import { RedisChildExecutionQueueRepository, RedisRateLimitRepository } from "../../src/index.js";
import { leasesOf, redisStore, testKeySpace } from "../support/redis-store.js";

/**
 * agbossjs/agboss#693 AC1 — every Redis store through the core's `storeConformance` (#526): the
 * lease, child-queue and rate-limit contracts, each as `<contract> (Redis)`, the `store set
 * (Redis)` cases, and the interleaving explorer on the lease store alone (`interleavings (Redis)`,
 * #694: every schedule of two instances, seeded walks of three, every clock skew, both #520
 * races). A set of coordination stores: no fenced-effect, outbound-call or lease-log store here —
 * their guarantee needs the lease in the write's own transaction (#526, ADR-0026), and the lease log
 * is a record, kept with the application's durable rows (#527).
 */
const space = testKeySpace("conformance");

afterAll(async () => {
  await space.close();
});

storeConformance({
  name: "Redis",
  interleavings: { depth: 8, walks: 200, timeLimit: 900_000 },
  reset: () => space.reset(),
  without: ["executionLeaseEvent", "fencedEffect", "outboundCall"],
  stores: {
    executionLease: redisStore(space, (connection, seam) => leasesOf(space, connection, seam)),
    childExecutionQueue: redisStore(
      space,
      (connection, seam) =>
        new RedisChildExecutionQueueRepository(connection, seam.clock, seam.application),
    ),
    rateLimit: redisStore(
      space,
      (connection, seam) => new RedisRateLimitRepository(connection, seam.clock, seam.application),
    ),
  },
});
