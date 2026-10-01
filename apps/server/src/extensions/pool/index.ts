/** Pool extension handlers: thin adapters from `extension.call` to the shared controller. */
import { PoolExtension } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import type { PoolController } from "./controller.ts";
import { getPoolController } from "./runtime.ts";
import { ExtensionFailure, serverExtension } from "./t3.ts";

const withController = <A>(run: (controller: PoolController) => Promise<A>) =>
  Effect.tryPromise({
    try: async () => {
      const controller = getPoolController();
      if (!controller) throw new Error("Account sharing isn't available on this server.");
      return run(controller);
    },
    catch: (cause) =>
      new ExtensionFailure({
        message: cause instanceof Error ? cause.message : String(cause),
        cause,
      }),
  });

// Built lazily: registry.ts imports this module while it is still being evaluated.
export const makePoolServerExtension = Effect.sync(() =>
  serverExtension(PoolExtension, {
    status: () => withController((pool) => pool.status()),
    "quota.refresh": () => withController((pool) => pool.refreshQuota()),
    setSource: (input) => withController((pool) => pool.setSource(input)),
    setRoute: ({ instanceId, mode }) => withController((pool) => pool.setRoute(instanceId, mode)),
    "login.start": ({ provider }) => withController((pool) => pool.startLogin(provider)),
    "login.status": ({ loginId }) => withController((pool) => pool.loginStatus(loginId)),
    "account.setEnabled": ({ id, enabled }) =>
      withController((pool) => pool.setAccountEnabled(id, enabled)),
    "account.remove": ({ id }) => withController((pool) => pool.removeAccount(id)),
    check: () => withController((pool) => pool.check()),
    restart: () => withController((pool) => pool.restart()),
    reset: ({ id }) => withController((pool) => pool.reset(id)),
    usage: (input) => withController((pool) => pool.usage(input)),
  }),
);
