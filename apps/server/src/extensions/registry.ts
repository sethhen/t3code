/**
 * Server half of the fork extension host (see packages/contracts/src/extensions/host.ts).
 *
 * `makeExtensionRegistry` runs once per ws connection next to the other RPC
 * handlers, so an extension's `make` effect should only capture services.
 * Anything that must be shared across connections (caches, write locks) lives
 * at module level in the extension itself.
 */
import {
  ExtensionCallError,
  type ExtensionCallInput,
  type ExtensionMethodSpec,
  type ExtensionMethods,
  type ExtensionSpec,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { makeServerExtensions } from "./index.ts";

/** The only failure an extension handler reports; its message is shown to the user. */
export class ExtensionFailure extends Data.TaggedError("ExtensionFailure")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export type ExtensionHandlers<Methods extends ExtensionMethods> = {
  readonly [Method in keyof Methods]: (
    input: Methods[Method]["input"]["Type"],
  ) => Effect.Effect<Methods[Method]["output"]["Type"], ExtensionFailure>;
};

type AnyHandler = (input: unknown) => Effect.Effect<unknown, ExtensionFailure>;

export interface ServerExtension {
  readonly spec: ExtensionSpec;
  readonly handlers: Readonly<Record<string, AnyHandler>>;
}

export const serverExtension = <Methods extends ExtensionMethods>(
  spec: ExtensionSpec<Methods>,
  handlers: ExtensionHandlers<Methods>,
): ServerExtension => ({
  spec,
  // Input is decoded against the method's schema before a handler runs.
  handlers: handlers as unknown as Readonly<Record<string, AnyHandler>>,
});

/** One method's handler with its codecs compiled once, when the registry is built. */
const compileMethod = (spec: ExtensionMethodSpec, handler: AnyHandler) => ({
  decodeInput: Schema.decodeUnknownEffect(spec.input),
  encodeOutput: Schema.encodeUnknownEffect(spec.output),
  handler,
});

/**
 * The wire is JSON, and its check rejects an `undefined` anywhere in a result,
 * which `Schema.optional` fields let a handler return. Encoded output drops
 * those keys instead of failing the whole call.
 */
const withoutUndefined = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(withoutUndefined);
  if (value === null || typeof value !== "object") return value;
  const kept: Record<string, unknown> = {};
  for (const [key, inner] of Object.entries(value)) {
    if (inner !== undefined) kept[key] = withoutUndefined(inner);
  }
  return kept;
};

/** Dispatch over `extensions`; exported for tests, the server uses `makeExtensionRegistry`. */
export const compileExtensions = (extensions: ReadonlyArray<ServerExtension>) => {
  const methods = new Map<string, ReturnType<typeof compileMethod>>();
  for (const extension of extensions) {
    for (const [name, spec] of Object.entries(extension.spec.methods)) {
      const handler = extension.handlers[name];
      if (handler) methods.set(`${extension.spec.id}.${name}`, compileMethod(spec, handler));
    }
  }

  const dispatch = (call: ExtensionCallInput): Effect.Effect<unknown, ExtensionCallError> => {
    const fail = (message: string) =>
      new ExtensionCallError({ extension: call.extension, method: call.method, message });
    const method = methods.get(`${call.extension}.${call.method}`);
    if (!method) {
      return Effect.fail(fail(`Unknown extension method ${call.extension}.${call.method}`));
    }
    return method.decodeInput(call.input).pipe(
      Effect.mapError((error) => fail(`Invalid input: ${error.message}`)),
      Effect.flatMap((input) =>
        method.handler(input).pipe(Effect.mapError((failure) => fail(failure.message))),
      ),
      Effect.flatMap((output) =>
        method.encodeOutput(output).pipe(
          Effect.map(withoutUndefined),
          Effect.mapError((error) => fail(`Invalid output: ${error.message}`)),
        ),
      ),
      Effect.catchDefect((defect) => Effect.fail(fail(Cause.pretty(Cause.die(defect))))),
    );
  };

  return { dispatch } as const;
};

export const makeExtensionRegistry = Effect.map(makeServerExtensions, compileExtensions);
