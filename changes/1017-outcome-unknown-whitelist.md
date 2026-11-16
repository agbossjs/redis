---
section: Fixed
issue: 1017
---

**A Redis write whose answer was lost is of unknown outcome** (agbossjs/agboss#1017): a write that fails after it was sent — a script, or the rate limits' direct `ZREM` and `DEL` — now rejects with `StoreOutcomeUnknownError` (`source: Transport`, the driver's error as `cause`) instead of an ordinary store error, so a leased tree is handed over and the next holder reconciles instead of failing the step and undoing an order whose write was applied. The rule is a whitelist: only an error that proves the command never ran (the client's never-sent classes, a connect error, a refusal before the script ran) is rethrown as it is; a socket, TLS, stream or timeout error, `OOM` and any error raised inside a script are unknown. A read keeps the driver's error. The table is in the README.
