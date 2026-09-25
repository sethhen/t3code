/**
 * Extension host - the fork's single seam for adding features without editing
 * the upstream RPC group, authorization table, or ws handler map.
 *
 * Every extension method travels through one generic `extension.call` RPC.
 * An extension declares its methods as input/output schema pairs with
 * `defineExtension`; the server validates input and encodes output with them,
 * and the client decodes the result with the same pair, so call sites stay
 * fully typed even though the wire payload is `unknown`.
 */
import * as Schema from "effect/Schema";

export const ExtensionCallInput = Schema.Struct({
  extension: Schema.String,
  method: Schema.String,
  input: Schema.Unknown,
});
export type ExtensionCallInput = typeof ExtensionCallInput.Type;

export class ExtensionCallError extends Schema.TaggedError<ExtensionCallError>()(
  "ExtensionCallError",
  {
    extension: Schema.String,
    method: Schema.String,
    message: Schema.String,
  },
) {}

/** A schema that needs no services to decode or encode, so both ends can run it anywhere. */
export type ExtensionSchema = Schema.Top & {
  readonly DecodingServices: never;
  readonly EncodingServices: never;
};

export interface ExtensionMethodSpec<
  Input extends ExtensionSchema = ExtensionSchema,
  Output extends ExtensionSchema = ExtensionSchema,
> {
  readonly input: Input;
  readonly output: Output;
}

export type ExtensionMethods = Readonly<Record<string, ExtensionMethodSpec>>;

export interface ExtensionSpec<Methods extends ExtensionMethods = ExtensionMethods> {
  readonly id: string;
  readonly methods: Methods;
}

export const defineExtension = <const Methods extends ExtensionMethods>(
  id: string,
  methods: Methods,
): ExtensionSpec<Methods> => ({ id, methods });

export type ExtensionMethodInput<
  Methods extends ExtensionMethods,
  Method extends keyof Methods,
> = Methods[Method]["input"]["Type"];

export type ExtensionMethodOutput<
  Methods extends ExtensionMethods,
  Method extends keyof Methods,
> = Methods[Method]["output"]["Type"];
