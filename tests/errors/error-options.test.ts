/**
 * #906 AC1 (completing #890, G8): every error `@agboss/redis` exports is made from one options
 * object whose keys are its own properties, with a `cause` that is kept — the core's convention. The
 * test walks the entry's exports and takes every `Error` subclass, `AGBossError` or not (#961, as
 * core and postgres do): a new error class without a fixture here fails it.
 */
import { describe, expect, it } from "vitest";
import * as entry from "../../src/index.js";

const FIXTURES: Readonly<Record<string, object>> = {
  RedisDeploymentError: { problems: ["a replica"] },
  RedisDurabilityError: { problems: ["appendonly is no"] },
  RedisLeaseKeyConflictError: { tenantId: "acme", executionId: "e-1" },
  RedisSettingsError: { message: "redisUrl is empty" },
};

type ErrorClass = abstract new (options: never) => Error;

const isErrorClass = (value: unknown): value is ErrorClass =>
  typeof value === "function" && value.prototype instanceof Error;

const classes = Object.entries(entry).flatMap(([name, value]): [string, ErrorClass][] =>
  isErrorClass(value) ? [[name, value]] : [],
);

/** `new ErrorClass(options)`, however its options are typed. */
const made = (ErrorClass: ErrorClass, options: object): Error => {
  const error: unknown = Reflect.construct(ErrorClass, [options]);
  if (!(error instanceof Error)) throw new TypeError("not an Error");
  return error;
};

describe("#906 AC1: every error takes one options bag with a cause", () => {
  it("AC1: each exported error has a fixture", () => {
    expect(classes.map(([name]) => name).sort()).toEqual(Object.keys(FIXTURES).sort());
  });

  it.each(classes)(
    "AC1: %s — keys are own properties, the cause is kept, the code literal",
    (name, ErrorClass) => {
      const options = FIXTURES[name] ?? {};
      const cause = new Error(`the cause of ${name}`);

      const error = made(ErrorClass, { ...options, cause });

      expect(error.cause).toBe(cause);
      expect(Object.keys(options).filter((key) => !Object.hasOwn(error, key))).toEqual([]);
      expect(Reflect.get(error, "code")).toBe(Reflect.get(ErrorClass, "code"));
      expect(made(ErrorClass, options)).toBeInstanceOf(Error);
    },
  );
});
