---
section: Fixed
issue: 989
---

**The tests' Redis URLs are pinned to the address that answers** (agbossjs/agboss#989): with
`localhost:<port>` and a server published on `127.0.0.1` only, a client's attempt on `::1` could be
given that port as its own source and connect to itself (on PostgreSQL that hung a gate for 17
minutes). Test setup only; the package is unchanged.
