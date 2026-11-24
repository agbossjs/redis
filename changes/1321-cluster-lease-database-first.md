---
section: Breaking
issue: 1321
---

**The Redis lease store is the core's cluster lease store: the database's lease row is the authority** (agbossjs/agboss#1321e, D6): `RedisExecutionLeaseRepository` now extends `ClusterExecutionLeaseRepository` with `RedisClusterCoordinator` (the Lua scripts of the lease's liveness) beside the store under `EXECUTION_ID_STORE`. A take is mirrored into the row before it is handed out, a release or retire is written to the row before the key changes, a mark (cancel, stop, pause, unpause) is written to the row and then pushed to Redis (a cache hash `<prefix>lease-marks:…` and a message on `<prefix>lease-marks` that only escalate: the cancel, the stop mode and the fence never go down). New script `RAISE_EPOCH` lifts a counter that fell behind the row (a flush, a restore, a failover) to at least the row's token and never lowers it; a Redis that stays behind after three catch-ups fails closed with `StoreError.ClusterLeaseBehind`. No lease key gets an expiry. No compatibility with 0.1.0 (D3/D4/D5): the stores' ids and marks are read from the database only.
