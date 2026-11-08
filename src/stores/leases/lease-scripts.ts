import { RedisScript } from "../../connection/scripts.js";
import { STORE_NOW_LUA } from "../store-time.js";

/**
 * The lease scripts of `RedisExecutionLeaseRepository` (agbossjs/agboss#693). One hash per tree,
 * `KEYS[1]`, never deleted and never given an expiry — so its token only grows (an evicting server
 * is refused at start, `maxmemory-policy noeviction`). Its fields:
 *
 * - `h` the holder's instance id, `e` the token (the fencing token, a counter of this key),
 * - `x` when the lease ends unless renewed, ms on the server's clock (`TIME`, or the test's),
 * - `s` the state: `h` held, `r` released, `f` retired (#520: never taken again),
 * - `y` `1` while the holder yielded it (#516).
 *
 * A lease is live while `x > now` and only then (#534): at the instant of its end it belongs to the
 * next taker, its holder included. Each script reads the time once, after every command before it
 * (a script runs alone), and answers what the lease has left by that same time (`remaining`).
 */

/** The holder's own lease, still live: its holder and token, held, `x > now` (renew/yield/reclaim). */
const HELD_LUA = `local function held(key, holder, epoch, now)
  local row = redis.call('HMGET', key, 'h', 'e', 'x', 's')
  return row[1] == holder and row[2] ~= false and tonumber(row[2]) == tonumber(epoch)
    and row[4] == 'h' and tonumber(row[3]) > now
end
`;

/**
 * `acquire`: ARGV holder, lease ms, time. Refused (nil) while another holder's lease is live, and
 * for good once retired. Otherwise the next token (1 for a new key), held for the lease from now;
 * a lease that expired without a release names its holder (`takenOverFrom`, #501).
 */
export const ACQUIRE = new RedisScript(`${STORE_NOW_LUA}
local now = store_now(ARGV[3])
local row = redis.call('HMGET', KEYS[1], 'h', 'e', 'x', 's')
local epoch = 0
local expired = false
if row[2] then
  epoch = tonumber(row[2])
  if row[4] == 'f' then return false end
  if row[4] == 'h' then
    if tonumber(row[3]) > now then return false end
    expired = true
  end
end
local expires = now + tonumber(ARGV[2])
redis.call('HSET', KEYS[1], 'h', ARGV[1], 'e', epoch + 1, 'x', expires, 's', 'h', 'y', '0')
if expired then return {epoch + 1, expires, expires - now, row[1], epoch} end
return {epoch + 1, expires, expires - now}
`);

/** `renew`: ARGV holder, token, lease ms, time — the time left, or nil once the lease is over. */
export const RENEW = new RedisScript(`${STORE_NOW_LUA}${HELD_LUA}
local now = store_now(ARGV[4])
if not held(KEYS[1], ARGV[1], ARGV[2], now) then return false end
local expires = now + tonumber(ARGV[3])
redis.call('HSET', KEYS[1], 'x', expires)
return expires - now
`);

/**
 * `yield`: ARGV holder, token, time — marked yielded, the ms the lease has left (not extended: a
 * yield is no renewal); nil once the lease is over.
 */
export const YIELD = new RedisScript(`${STORE_NOW_LUA}${HELD_LUA}
local now = store_now(ARGV[3])
if not held(KEYS[1], ARGV[1], ARGV[2], now) then return false end
redis.call('HSET', KEYS[1], 'y', '1')
return tonumber(redis.call('HGET', KEYS[1], 'x')) - now
`);

/** `reclaim`: ARGV holder, token, lease ms, time — the next token held again, or nil. */
export const RECLAIM = new RedisScript(`${STORE_NOW_LUA}${HELD_LUA}
local now = store_now(ARGV[4])
if not held(KEYS[1], ARGV[1], ARGV[2], now) then return false end
local epoch = tonumber(ARGV[2]) + 1
local expires = now + tonumber(ARGV[3])
redis.call('HSET', KEYS[1], 'e', epoch, 'x', expires, 'y', '0')
return {epoch, expires, expires - now}
`);

/**
 * `release` (ARGV holder, token, `r`) and `retire` (`f`): the caller's own lease — its holder and
 * token, also past its end or already released — so a lease another instance took meanwhile (a
 * later token) is kept; a retired one stays retired.
 */
export const CLOSE = new RedisScript(`
local row = redis.call('HMGET', KEYS[1], 'h', 'e', 's')
if row[1] ~= ARGV[1] or row[2] == false or tonumber(row[2]) ~= tonumber(ARGV[2]) then return 0 end
if row[3] == 'f' then return 0 end
redis.call('HSET', KEYS[1], 's', ARGV[3], 'y', '0')
return 1
`);
