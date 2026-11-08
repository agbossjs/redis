import { type StoreClock, StoreTimeSource } from "@agboss/core";

/**
 * The time a lease script decides by (agbossjs/agboss#533, clock authority): the server's own,
 * `TIME` read inside the script — so every instance agrees on a lease's expiry whatever its own
 * wall clock says, and the instant of a take, a renewal or a check is the instant the script runs,
 * after every command before it; or, when a test injected its clock (`StoreClock.source` not
 * `StoreTimeSource.Database`), that clock's time as the script's argument, so the contract suites can move it. One
 * script for both: the argument is empty in production.
 */

/** The script's time argument: `""` (the server's `TIME`), or the test's clock now, in ms. */
export const storeNowArgumentOf = (clock: StoreClock): string =>
  clock.source === StoreTimeSource.Database ? "" : String(clock.now().getTime());

/**
 * `store_now(argument)` in Lua: the argument's ms when given, else the server's `TIME` in whole
 * ms (seconds × 1000 + microseconds ÷ 1000, rounded down).
 */
export const STORE_NOW_LUA = `local function store_now(given)
  if given ~= '' then return tonumber(given) end
  local time = redis.call('TIME')
  return tonumber(time[1]) * 1000 + math.floor(tonumber(time[2]) / 1000)
end
`;
