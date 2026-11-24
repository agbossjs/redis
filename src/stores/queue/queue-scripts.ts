import { RedisScript } from "../../connection/scripts.js";

/**
 * The scripts of `RedisChildExecutionQueueRepository` (agbossjs/agboss#693). A child is one hash
 * (`KEYS[1]` of save and complete); the queued ones are one sorted set — score `−depth`, member
 * `<queuedAt as 17 digits><the child's row id>` — so its first member is the deepest, then the
 * longest waiting (equal scores sort by member); a tree's children are one set of row ids, what
 * `deleteAll` removes. For the depth (agbossjs/agboss#485) every script that moves a row keeps two
 * more: the queued members again, each scored 0 — so the first is the longest waiting of all —, and
 * the running rows' keys. The statuses are `ExecutionRecordStatus`'s values.
 */

/**
 * A save: KEYS row, the queue this child belongs on (the general one, or the isolated workers'), the tree's set, the queued by
 * time, the running, the other queue; ARGV the row id, the queue member, −depth, the claim a
 * requeue names (`claimedAt` ms; empty, which no stored claim equals: none), the wake-up channel, then the fields as name/value
 * pairs. Saved when the child is new, paused (resumed), or running under exactly that claim (its
 * worker lost its lease); 1 when saved. A save publishes on the channel (agbossjs/agboss#777):
 * inside the script, so the message goes out once the row is written, and only then.
 */
export const SAVE = new RedisScript(`
local status = redis.call('HGET', KEYS[1], 'status')
if status then
  local claim = redis.call('HGET', KEYS[1], 'claimedAt')
  local requeued = status == 'paused' or (status == 'running' and claim == ARGV[4])
  if not requeued then return 0 end
  local member = redis.call('HGET', KEYS[1], 'member')
  if member then
    redis.call('ZREM', KEYS[2], member)
    redis.call('ZREM', KEYS[6], member)
    redis.call('ZREM', KEYS[4], member)
  end
  redis.call('SREM', KEYS[5], KEYS[1])
end
redis.call('DEL', KEYS[1])
redis.call('HSET', KEYS[1], 'member', ARGV[2], unpack(ARGV, 6))
redis.call('ZADD', KEYS[2], ARGV[3], ARGV[2])
redis.call('ZADD', KEYS[4], 0, ARGV[2])
redis.call('SADD', KEYS[3], ARGV[1])
redis.call('PUBLISH', ARGV[5], 'queued')
return 1
`);

/** The length of the member's time part: `queuedAt` + 8.64e15 ms, 17 digits (any `Date`). */
export const QUEUED_AT_DIGITS = 17;

/**
 * A claim: KEYS the general queue, the queued by time, the running; ARGV the key prefix of the rows, the instance, now (ms). The first
 * member whose child is not excluded from this instance (`excludeInstanceId`, `OtherWorker`, #1286: it stays queued
 * for another instance) is taken off the queue and its row marked running for this instance; the row as
 * name/value pairs, or nil when nothing is queued for it. A member whose row is gone is dropped. The isolated
 * workers' children are on a queue of their own (`CLAIM_ISOLATED`): never claimed here.
 */
export const CLAIM = new RedisScript(`
local at = 0
while true do
  local first = redis.call('ZRANGE', KEYS[1], at, at)
  if #first == 0 then return false end
  local row = ARGV[1] .. string.sub(first[1], ${String(QUEUED_AT_DIGITS + 1)})
  local fields = redis.call('HMGET', row, 'status', 'excludeInstanceId')
  if fields[1] ~= 'queued' then
    redis.call('ZREM', KEYS[1], first[1])
    redis.call('ZREM', KEYS[2], first[1])
  elseif fields[2] == ARGV[2] then
    at = at + 1
  else
    redis.call('ZREM', KEYS[1], first[1])
    redis.call('ZREM', KEYS[2], first[1])
    redis.call('HSET', row, 'status', 'running', 'instanceId', ARGV[2], 'claimedAt', ARGV[3])
    redis.call('HDEL', row, 'member')
    redis.call('SADD', KEYS[3], row)
    return redis.call('HGETALL', row)
  end
end
`);

/**
 * The isolated workers' queued children (#1286b): KEYS their queue; ARGV the key prefix of the rows, the limit — each queued
 * child's row as name/value pairs, the deepest first, then the longest waiting, at most the limit. A read: nothing is claimed.
 */
export const QUEUED_ISOLATED = new RedisScript(
  `
local found = {}
local at = 0
while #found < tonumber(ARGV[2]) do
  local member = redis.call('ZRANGE', KEYS[1], at, at)
  if #member == 0 then break end
  local row = ARGV[1] .. string.sub(member[1], ${String(QUEUED_AT_DIGITS + 1)})
  if redis.call('HGET', row, 'status') == 'queued' then found[#found + 1] = redis.call('HGETALL', row) end
  at = at + 1
end
return found
`,
  true,
);

/**
 * The targeted claim of an isolated worker's child (#1286b): KEYS the row, the isolated queue, the queued by time, the running;
 * ARGV the instance, now (ms). Claimed only when it is queued with that placement — running for this instance, taken off both
 * queues; its row as name/value pairs, or nil. Of two forks of one child exactly one gets it.
 */
export const CLAIM_ISOLATED = new RedisScript(`
local row = redis.call('HMGET', KEYS[1], 'status', 'placement', 'member')
if row[1] ~= 'queued' or row[2] ~= 'isolated-worker' then return false end
if row[3] then
  redis.call('ZREM', KEYS[2], row[3])
  redis.call('ZREM', KEYS[3], row[3])
end
redis.call('HSET', KEYS[1], 'status', 'running', 'instanceId', ARGV[1], 'claimedAt', ARGV[2])
redis.call('HDEL', KEYS[1], 'member')
redis.call('SADD', KEYS[4], KEYS[1])
return redis.call('HGETALL', KEYS[1])
`);

/**
 * A withdrawal (#1286a): KEYS the row, the general queue, the isolated queue, the queued by time, the tree's set; ARGV the row
 * id. Only a child still queued — its row and its queue entries removed, atomically with a claim, which marks the row running
 * first: 1 when this call removed it, 0 when it is not queued.
 */
export const WITHDRAW = new RedisScript(`
local row = redis.call('HMGET', KEYS[1], 'status', 'member')
if row[1] ~= 'queued' then return 0 end
if row[2] then
  redis.call('ZREM', KEYS[2], row[2])
  redis.call('ZREM', KEYS[3], row[2])
  redis.call('ZREM', KEYS[4], row[2])
end
redis.call('SREM', KEYS[5], ARGV[1])
redis.call('DEL', KEYS[1])
return 1
`);

/**
 * A completion: KEYS the row, the running; ARGV the instance, the end's status, now (ms), the failure (empty: none) — only
 * this instance's running child; 1 when ended.
 */
export const COMPLETE = new RedisScript(`
local row = redis.call('HMGET', KEYS[1], 'status', 'instanceId')
if row[1] ~= 'running' or row[2] ~= ARGV[1] then return 0 end
redis.call('HSET', KEYS[1], 'status', ARGV[2], 'endedAt', ARGV[3])
redis.call('SREM', KEYS[2], KEYS[1])
if ARGV[4] ~= '' then redis.call('HSET', KEYS[1], 'failure', ARGV[4]) else redis.call('HDEL', KEYS[1], 'failure') end
return 1
`);

/** A tree's end: KEYS its set, the queue, the queued by time, the running, the isolated queue; ARGV the rows' prefix — every row and queue entry gone. */
export const DELETE_TREE = new RedisScript(`
for _, id in ipairs(redis.call('SMEMBERS', KEYS[1])) do
  local row = ARGV[1] .. id
  local member = redis.call('HGET', row, 'member')
  if member then
    redis.call('ZREM', KEYS[2], member)
    redis.call('ZREM', KEYS[3], member)
    redis.call('ZREM', KEYS[5], member)
  end
  redis.call('SREM', KEYS[4], row)
  redis.call('DEL', row)
end
redis.call('DEL', KEYS[1])
return 1
`);

/**
 * The depth (agbossjs/agboss#485): KEYS the queued by time — every queued member, the isolated workers' too —, the running —
 * the queued count, the running count and the longest-waiting queued member (false: none), in one round trip.
 */
export const DEPTH = new RedisScript(
  `
local oldest = redis.call('ZRANGE', KEYS[1], 0, 0)
return { redis.call('ZCARD', KEYS[1]), redis.call('SCARD', KEYS[2]), oldest[1] or false }
`,
  true,
);
