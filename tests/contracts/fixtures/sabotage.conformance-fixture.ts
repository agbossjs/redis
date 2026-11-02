// agbossjs/agboss#693 AC3: the core's suites on two broken Redis lease stores (sabotage-stores.ts),
// run in a vitest of its own by sabotage.test.ts, which reads what failed.
import { storeConformance } from "@agboss/core/testing/contracts";
import { afterAll } from "vitest";
import { redisStore, testKeySpace } from "../../support/redis-store.js";
import { CallerStoreClock, ReadThenWriteLeaseRepository } from "./sabotage-stores.js";
import { TestRedisExecutionLeaseRepository } from "../../support/redis-store.js";

const WITHOUT = ["executionLeaseEvent", "fencedEffect", "outboundCall"] as const;
const BUDGET = { depth: 6, walks: 20, walkDepth: 20 };

const callerClock = testKeySpace("sabotage-caller-clock");
const readThenWrite = testKeySpace("sabotage-read-then-write");

afterAll(async () => {
  await callerClock.close();
  await readThenWrite.close();
});

storeConformance({
  name: "Redis leases on the caller's clock",
  interleavings: BUDGET,
  reset: () => callerClock.reset(),
  without: WITHOUT,
  stores: {
    executionLease: redisStore(
      callerClock,
      (connection, seam) =>
        new TestRedisExecutionLeaseRepository(
          connection,
          new CallerStoreClock(seam.clock),
          seam.application,
          callerClock.keptIds,
        ),
    ),
  },
});

storeConformance({
  name: "Redis leases taken by a read, then a write",
  interleavings: BUDGET,
  reset: () => readThenWrite.reset(),
  without: WITHOUT,
  stores: {
    executionLease: redisStore(
      readThenWrite,
      (connection, seam) =>
        new ReadThenWriteLeaseRepository(
          connection,
          seam.storeClock,
          seam.application,
          readThenWrite.keptIds,
        ),
    ),
  },
});
