---
section: Changed
issue: 1064
---

**Pinned on the core of agbossjs/agboss#941, #942, #1099, #1115, #1117 and #1131**
(agbossjs/agboss#1064): the whole conformance suite and the fault scenarios pass on the Redis stores.
Redis keeps no pause store and no fencing store, so the pause contract (the deadline compare-and-set,
the keyset scans, `renewNotice`) has nothing to change here. The tree's cancel mark goes to the durable
store under `EXECUTION_ID_STORE` (see agbossjs/agboss#1152). No migration.
