---
section: Fixed
issue: 954
---

**`RedisConnection` implements the core's `OnAbandon`** (agbossjs/agboss#954, #1432): when the stop's end passes with the connection's `onDestroy` still running (a quiet server never answered the `QUIT` and the sweep or workers used up the shutdown timeout), the core gives that hook up and calls `onAbandon()` once, synchronously: it hands out no more subscribers and destroys the main client's socket and every subscriber's at once, so `close()` returns with no socket open. It never throws. Pinned on core `main` bd7f59689. No migration.
