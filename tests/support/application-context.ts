import { ApplicationContext, type HostContext } from "@agboss/core";

/**
 * An application context as the framework gives a store (`deps: [ApplicationContext]`), with the
 * environment a test names — its `redisUrl` a secret-like value: only `reveal()` gives the URL.
 */
export class TestApplicationContext extends ApplicationContext {
  readonly name = "redis-test-application";
  readonly version = "1.0.0";
  readonly instanceId: string;
  readonly startedAt = new Date("2026-01-05T09:00:00.000Z");
  readonly environmentName = "test";
  readonly profiles: ApplicationContext["profiles"] = ["test"];
  readonly environment: ApplicationContext["environment"];
  readonly host: HostContext = {
    hostname: "test-host",
    pid: 1,
    platform: "linux",
    runtimeVersion: "v22.13.0",
  };

  constructor(environment: object, instanceId = "instance-1") {
    super();
    // the test's object is the store's own settings, not the layout application's typed environment
    this.environment = environment as ApplicationContext["environment"];
    this.instanceId = instanceId;
  }
}

/** What `secret("…")` resolves to in an environment: `reveal()` gives the value, printed as ***. */
export const revealing = (value: string): { reveal(): string; toString(): string } => ({
  reveal: () => value,
  toString: () => "***",
});
