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

/**
 * `raiseEpoch` (D6, #1321e): ARGV the token the database's lease row is at. The tree's counter `e`
 * becomes at least that — never lower —, so that the next take is above the row's token: how a
 * Redis that lost its counters (a flush, a restore from an old snapshot) catches up with the
 * database, which is the authority. A key that does not exist is made released (`s` `r`, no holder,
 * `x` 0) at that token, so that `ACQUIRE` takes `token + 1` and names no takeover; a retired key
 * stays retired and a held one stays its holder's row — its token no longer matches, so its holder
 * is refused at the next renewal, which is what a stale lease must meet. Answers the counter.
 */
export const RAISE_EPOCH = new RedisScript(`
local floor = tonumber(ARGV[1])
local epoch = redis.call('HGET', KEYS[1], 'e')
if epoch == false then
  if floor <= 0 then return 0 end
  redis.call('HSET', KEYS[1], 'h', '', 'e', ARGV[1], 'x', 0, 's', 'r', 'y', '0')
  return floor
end
if tonumber(epoch) >= floor then return tonumber(epoch) end
redis.call('HSET', KEYS[1], 'e', ARGV[1])
return floor
`);

/**
 * `publishMarks` (D6, #1321e): the tree's marks as the database holds them, cached in the hash
 * `KEYS[1]` and signalled on a channel — a cache and a wake-up, never read back as an authority.
 * Every field only escalates, so a late or repeated push can never lower a mark the cache already
 * shows: the cancel `c` once `1` stays `1`; the stop mode `s` goes `after-step` → `immediate` and
 * never back; the fence `f` is the highest token seen. The pause `p` / `r` (mode, reason) is the
 * one mark the database lifts (`unpause`), so a push that names none clears it — a lagging cache
 * of it is repaired by the next push, which a repeat of the command makes — and a push that names
 * one escalates the mode while it is paused. ARGV: the cancel `1` / `0`, the stop mode (empty: none),
 * the pause mode (empty: none), its reason, the fence (empty: none), the channel, the message.
 */
export const PUBLISH_MARKS = new RedisScript(`
local function rank(mode)
  if mode == 'immediate' then return 2 end
  if mode == 'after-step' then return 1 end
  return 0
end
if ARGV[1] == '1' then redis.call('HSET', KEYS[1], 'c', '1') end
if rank(ARGV[2]) > rank(redis.call('HGET', KEYS[1], 's') or '') then
  redis.call('HSET', KEYS[1], 's', ARGV[2])
end
if ARGV[5] ~= '' then
  local fence = redis.call('HGET', KEYS[1], 'f')
  if fence == false or tonumber(ARGV[5]) > tonumber(fence) then redis.call('HSET', KEYS[1], 'f', ARGV[5]) end
end
if ARGV[3] == '' then
  redis.call('HDEL', KEYS[1], 'p', 'r')
else
  local held = redis.call('HGET', KEYS[1], 'p') or ''
  local mode = ARGV[3]
  if rank(held) > rank(mode) then mode = held end
  redis.call('HSET', KEYS[1], 'p', mode, 'r', ARGV[4])
end
redis.call('PUBLISH', ARGV[6], ARGV[7])
return 1
`);
