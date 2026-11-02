import { faultSuite } from "@agboss/core/testing/faults";
import { redisFaultTarget } from "./redis-target.js";

/**
 * agbossjs/agboss#693 AC2 — every scenario of the core's fault suite with the Redis child queue and
 * rate limits: real `node` pods killed, stopped, frozen and cut off their file, every invariant
 * checked after each — `children-once` on the Redis queue, `linearizable` on the fencing history
 * (`npm run test:faults`, CI's `faults` jobs).
 */
faultSuite(redisFaultTarget());
