---
section: Breaking
issue: 1321
---

**The child queue keeps a child's placement** (agbossjs/agboss#1321, #1286): `RedisChildExecutionQueueRepository` stores `placement` and `excludeInstanceId` in the row, keeps the isolated workers' children on a queue of their own (`<prefix>children-queued-isolated`, never taken by the general claim), skips an `OtherWorker` child for the instance that queued it, and adds `findQueuedIsolatedWorkerChildren`, `claimIsolatedWorkerByTenantIdAndExecutionId` and `withdrawByTenantIdAndExecutionIdIfQueued` (one script each, atomic with the claim). The depth counts every queued child, the isolated workers' included.
