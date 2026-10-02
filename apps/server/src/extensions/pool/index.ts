/** Pool extension handlers: thin adapters from `extension.call` to the shared move controller. */
import { PoolExtension } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import type { MoveController } from "./move.ts";
import { getMoveController } from "./runtime.ts";
import { ExtensionFailure, serverExtension } from "./t3.ts";

const withController = <A>(run: (controller: MoveController) => A | Promise<A>) =>
  Effect.tryPromise({
    try: async () => {
      const controller = getMoveController();
      if (!controller) throw new Error("Moving accounts isn't available on this server.");
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
    status: () => withController((move) => move.status()),
    "signIn.start": ({ accountId }) => withController((move) => move.startSignIn(accountId)),
    "account.add": ({ provider }) => withController((move) => move.addAccount(provider)),
    "account.signIn": ({ instanceId }) => withController((move) => move.signInAgain(instanceId)),
    "signIn.status": ({ signInId }) => withController((move) => move.signInState(signInId)),
    "signIn.code": ({ signInId, code }) =>
      withController((move) => move.submitCode(signInId, code)),
    "signIn.cancel": ({ signInId }) => withController((move) => move.cancelSignIn(signInId)),
    "account.remove": ({ instanceId }) => withController((move) => move.removeAccount(instanceId)),
    skip: ({ accountId }) => withController((move) => move.skip(accountId)),
  }),
);
