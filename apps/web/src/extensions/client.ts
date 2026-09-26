/**
 * Typed client for fork extension methods. Calls ride the generic
 * `extension.call` RPC; results are decoded against the method's output schema
 * so panels work with real types, and failures come back as a plain message.
 * `call` never rejects.
 */
import { createEnvironmentRpcCommand } from "@t3tools/client-runtime/state/runtime";
import {
  type EnvironmentId,
  type ExtensionMethodInput,
  type ExtensionMethodOutput,
  type ExtensionMethods,
  type ExtensionSpec,
  WS_METHODS,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Schema from "effect/Schema";
import { AsyncResult } from "effect/unstable/reactivity";
import { useMemo } from "react";

import { connectionAtomRuntime } from "../connection/runtime";
import { useAtomCommand } from "../state/use-atom-command";

const extensionCallCommand = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "extension:call",
  tag: WS_METHODS.extensionCall,
});

export type ExtensionCallOutcome<Value> =
  | { readonly ok: true; readonly value: Value }
  | { readonly ok: false; readonly message: string };

export interface ExtensionClient<Methods extends ExtensionMethods> {
  readonly call: <Method extends keyof Methods & string>(
    method: Method,
    input: ExtensionMethodInput<Methods, Method>,
  ) => Promise<ExtensionCallOutcome<ExtensionMethodOutput<Methods, Method>>>;
}

type Codec = {
  readonly encodeInput: (input: unknown) => unknown;
  readonly decodeOutput: (output: unknown) => unknown;
};

const codecsBySpec = new WeakMap<ExtensionSpec, Map<string, Codec>>();

/** Compiles each method's codecs once per spec, on first use. */
function codecFor(spec: ExtensionSpec, method: string): Codec | undefined {
  let codecs = codecsBySpec.get(spec);
  if (!codecs) {
    codecs = new Map(
      Object.entries(spec.methods).map(([name, methodSpec]) => [
        name,
        {
          encodeInput: Schema.encodeUnknownSync(methodSpec.input),
          decodeOutput: Schema.decodeUnknownSync(methodSpec.output),
        },
      ]),
    );
    codecsBySpec.set(spec, codecs);
  }
  return codecs.get(method);
}

function failureMessage(cause: Cause.Cause<unknown>): string {
  const error = Cause.squash(cause);
  if (error && typeof error === "object" && "message" in error) {
    return String(error.message);
  }
  return String(error);
}

/** Calls one extension's methods against one environment. */
export function useExtensionClient<Methods extends ExtensionMethods>(
  spec: ExtensionSpec<Methods>,
  environmentId: EnvironmentId | null,
): ExtensionClient<Methods> {
  const run = useAtomCommand(extensionCallCommand, { reportFailure: false });
  return useMemo(
    () => ({
      call: async (method, input) => {
        if (environmentId === null) return { ok: false, message: "No environment connected." };
        const codec = codecFor(spec, method);
        if (!codec) return { ok: false, message: `Unknown method ${spec.id}.${method}` };
        let payload: unknown;
        try {
          payload = codec.encodeInput(input);
        } catch (error) {
          return { ok: false, message: `Invalid input: ${String(error)}` };
        }
        let result: Awaited<ReturnType<typeof run>>;
        try {
          result = await run({
            environmentId,
            input: { extension: spec.id, method, input: payload },
          });
        } catch (error) {
          return { ok: false, message: error instanceof Error ? error.message : String(error) };
        }
        if (!AsyncResult.isSuccess(result)) {
          return { ok: false, message: failureMessage(result.cause) };
        }
        try {
          return { ok: true, value: codec.decodeOutput(result.value) as never };
        } catch (error) {
          return { ok: false, message: `Unexpected response: ${String(error)}` };
        }
      },
    }),
    [environmentId, run, spec],
  );
}
