---
section: Fixed
issue: 789
---

**The child queue's subscription notices a connection that dies silently** (agbossjs/agboss#789)
— a half-open TCP connection (a NAT or a load balancer that lost its state: no FIN, no RST) no
longer stops the wake-ups of #777 with no sign. The watch pings its subscriber (`PING`, plus the
TCP keepalive node-redis keeps) and, when the answer does not come within
`redisWatchLivenessSeconds` (default 10 s, at least 2:
`RedisConnectionSettings.watchLivenessSeconds`), logs `child-queue.watch-connection-lost` at
`warn`, subscribes on a new connection and wakes the claimers once. Every timer is on the
`Clock`. `RedisChildExecutionQueueRepository` takes the `Logger` as its fourth dependency.
