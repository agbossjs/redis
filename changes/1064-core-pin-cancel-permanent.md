---
section: Changed
issue: 1064
---

**Pinned on the core of agbossjs/agboss#941, #942, #1099, #1115, #1117 and #1131**
(agbossjs/agboss#1064): the whole conformance suite and the fault scenarios pass on the Redis stores.
Redis keeps no pause store and no fencing store, so the pause contract (the deadline compare-and-set,
the keyset scans, `renewNotice`) and the tree's cancel mark have nothing to change here:
`RedisExecutionLeaseRepository.requestCancel` still resolves and writes nothing — no seed key for a
tree never acquired, no field on a lease key — and the lease contract's case "the mark kept on the
tree's lease row changes no lease" (agbossjs/agboss#1117) passes on it. A test reads the server before
and after the cancel to prove it. No migration.
