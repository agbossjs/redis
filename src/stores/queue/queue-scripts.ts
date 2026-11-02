import { RedisScript } from "../../connection/scripts.js";

/**
 * The scripts of `RedisChildExecutionQueueRepository` (agbossjs/agboss#693). A child is one hash
 * (`KEYS[1]` of save and complete); the queued ones are one sorted set — score `−depth`, member
 * `<queuedAt as 17 digits><the child's row id>` — so its first member is the deepest, then the
 * longest waiting (equal scores sort by member); a tree's children are one set of row ids, what
 * `deleteAll` removes. The statuses are `ExecutionRecordStatus`'s values.
 */

/**
 * A save: KEYS row, queue, the tree's set; ARGV the row id, the queue member, −depth, the claim a
 * requeue names (`claimedAt` ms, empty: none), then the fields as name/value pairs. Saved when the
 * child is new, paused (resumed), or running under exactly that claim (its worker lost its lease);
 * 1 when saved.
 */
export const SAVE = new RedisScript(`
local status = redis.call('HGET', KEYS[1], 'status')
if status then
  local claim = redis.call('HGET', KEYS[1], 'claimedAt')
  local requeued = status == 'paused' or (status == 'running' and ARGV[4] ~= '' and claim == ARGV[4])
  if not requeued then return 0 end
  local member = redis.call('HGET', KEYS[1], 'member')
  if member then redis.call('ZREM', KEYS[2], member) end
end
redis.call('DEL', KEYS[1])
redis.call('HSET', KEYS[1], 'member', ARGV[2], unpack(ARGV, 5))
redis.call('ZADD', KEYS[2], ARGV[3], ARGV[2])
redis.call('SADD', KEYS[3], ARGV[1])
return 1
`);

/** The length of the member's time part: `queuedAt` + 8.64e15 ms, 17 digits (any `Date`). */
export const QUEUED_AT_DIGITS = 17;

/**
 * A claim: KEYS the queue; ARGV the key prefix of the rows, the instance, now (ms). The first
 * member is taken off the queue and its row marked running for this instance; the row as
 * name/value pairs, or nil when nothing is queued. A member whose row is gone is dropped.
 */
export const CLAIM = new RedisScript(`
while true do
  local first = redis.call('ZRANGE', KEYS[1], 0, 0)
  if #first == 0 then return false end
  redis.call('ZREM', KEYS[1], first[1])
  local row = ARGV[1] .. string.sub(first[1], ${String(QUEUED_AT_DIGITS + 1)})
  if redis.call('HGET', row, 'status') == 'queued' then
    redis.call('HSET', row, 'status', 'running', 'instanceId', ARGV[2], 'claimedAt', ARGV[3])
    redis.call('HDEL', row, 'member')
    return redis.call('HGETALL', row)
  end
end
`);

/**
 * A completion: ARGV the instance, the end's status, now (ms), the failure (empty: none) — only
 * this instance's running child; 1 when ended.
 */
export const COMPLETE = new RedisScript(`
local row = redis.call('HMGET', KEYS[1], 'status', 'instanceId')
if row[1] ~= 'running' or row[2] ~= ARGV[1] then return 0 end
redis.call('HSET', KEYS[1], 'status', ARGV[2], 'endedAt', ARGV[3])
if ARGV[4] ~= '' then redis.call('HSET', KEYS[1], 'failure', ARGV[4]) else redis.call('HDEL', KEYS[1], 'failure') end
return 1
`);

/** A tree's end: KEYS its set, the queue; ARGV the rows' prefix — every row and queue entry gone. */
export const DELETE_TREE = new RedisScript(`
for _, id in ipairs(redis.call('SMEMBERS', KEYS[1])) do
  local row = ARGV[1] .. id
  local member = redis.call('HGET', row, 'member')
  if member then redis.call('ZREM', KEYS[2], member) end
  redis.call('DEL', row)
end
redis.call('DEL', KEYS[1])
return 1
`);
