---
section: Changed
issue: 1017
---

**The invariant behind the unknown-outcome whitelist is enforced** (agbossjs/agboss#1017, agbossjs/redis#44): a refusal word (`BUSY`, `READONLY`, …) without the server's `@user_script` suffix is read as "refused before the script ran", so no script of the stores may return an error reply of its own that starts with one. The rule is written at `RedisScript`, and a guard test scans the sources of `src/stores` and fails on such a reply, or on one whose text is not a literal. No change to the stores' behaviour.
