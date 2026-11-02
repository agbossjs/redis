import { RedisScript } from "../../connection/scripts.js";

/**
 * The scripts of `RedisRateLimitRepository` (agbossjs/agboss#693). Times are the framework
 * `Clock`'s, passed in ms (the core's A10: rate-limit and tree slots are not money — counted on
 * the caller's clock). Each key also gets an expiry of its own once nothing in it can matter — its
 * latest end plus an hour — so a tree's slots (`tree:<tenant>:<root>`) do not stay forever; the
 * expiry only grows (`extend`), never shortens a key another instance still counts on.
 */

/** `extend(key, ttl)`: the key's expiry pushed out to `ttl` ms from now, never pulled in. */
const EXTEND_LUA = `local function extend(key, ttl)
  local left = redis.call('PTTL', key)
  if left < ttl then redis.call('PEXPIRE', key, ttl) end
end
`;

/**
 * A slot: KEYS[1] the key's slots (a sorted set, slot id → its end); ARGV slot id, max slots, its
 * end, now, ttl. The ended slots (`end <= now`) are swept, and the new one added only while fewer
 * than max are live. 1 when taken.
 */
export const TAKE_SLOT = new RedisScript(`${EXTEND_LUA}
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', ARGV[4])
if redis.call('ZCARD', KEYS[1]) >= tonumber(ARGV[2]) then return 0 end
redis.call('ZADD', KEYS[1], ARGV[3], ARGV[1])
extend(KEYS[1], tonumber(ARGV[5]))
return 1
`);

/** A renewal: ARGV slot id, its new end, now, ttl — only a slot still live (an ended one is given away). */
export const RENEW_SLOT = new RedisScript(`${EXTEND_LUA}
local ends = redis.call('ZSCORE', KEYS[1], ARGV[1])
if not ends or tonumber(ends) <= tonumber(ARGV[3]) then return 0 end
redis.call('ZADD', KEYS[1], 'XX', ARGV[2], ARGV[1])
extend(KEYS[1], tonumber(ARGV[4]))
return 1
`);

/**
 * A count in a sliding window: KEYS[1] the entries (a sorted set, entry id → when it was counted),
 * KEYS[2] their amounts (a hash); ARGV now, window, amount, limit (empty: none), a new entry id,
 * ttl. The entries out of the window (`counted <= now − window`) are forgotten; the total of the
 * rest plus `amount` is refused (nil, nothing counted) past the limit, else counted (`amount` 0
 * counts nothing) and answered as text (a sum is not cut to an integer).
 */
export const ADD_TO_WINDOW = new RedisScript(`${EXTEND_LUA}
local now = tonumber(ARGV[1])
local since = now - tonumber(ARGV[2])
local gone = redis.call('ZRANGEBYSCORE', KEYS[1], '-inf', since)
for at = 1, #gone, 500 do
  redis.call('HDEL', KEYS[2], unpack(gone, at, math.min(at + 499, #gone)))
end
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', since)
local total = tonumber(ARGV[3])
for _, amount in ipairs(redis.call('HVALS', KEYS[2])) do total = total + tonumber(amount) end
if ARGV[4] ~= '' and total > tonumber(ARGV[4]) then return false end
if tonumber(ARGV[3]) ~= 0 then
  redis.call('ZADD', KEYS[1], now, ARGV[5])
  redis.call('HSET', KEYS[2], ARGV[5], ARGV[3])
  extend(KEYS[1], tonumber(ARGV[6]))
  extend(KEYS[2], tonumber(ARGV[6]))
end
return tostring(total)
`);

/** A pause: ARGV its end, ttl — the later of the stored end and this one is kept. */
export const PAUSE = new RedisScript(`
local stored = redis.call('GET', KEYS[1])
if stored and tonumber(stored) >= tonumber(ARGV[1]) then return 0 end
redis.call('SET', KEYS[1], ARGV[1], 'PX', ARGV[2])
return 1
`);
