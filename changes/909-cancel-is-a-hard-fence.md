---
section: Changed
issue: 909
---

**`RedisExecutionLeaseRepository` implements `requestCancel(tree)`** (agbossjs/agboss#909): the core's
lease contract gained the method for the cancel fence. Redis keeps no fenced-effect or outbound-call
stores (those are the application's other stores), so the method resolves and writes nothing; the
fence is the fencing stores' (PostgreSQL, MongoDB, SQLite). Nothing to migrate.
