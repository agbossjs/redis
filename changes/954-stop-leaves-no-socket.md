---
section: Fixed
issue: 954
---

**An instance's stop against a quiet Redis leaves no socket open** (agbossjs/agboss#954) — the child queue's subscriber, still connecting or owned by a worker the stop gave up on, kept its socket: `RedisConnection.onDestroy` now destroys every subscriber it handed out, a client is destroyed whatever its `isOpen`, and once the stop began no new subscriber is handed out (a late resubscribe of an abandoned watch opens nothing).
