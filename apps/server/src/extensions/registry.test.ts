import { defineExtension } from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { compileExtensions, serverExtension } from "./registry.ts";

const Row = Schema.Struct({
  name: Schema.String,
  updateAvailable: Schema.optional(Schema.Boolean),
});
const isJson = Schema.is(Schema.Json);
const spec = defineExtension("test", {
  list: { input: Schema.Struct({}), output: Schema.Struct({ rows: Schema.Array(Row) }) },
});

describe("extension registry", () => {
  it.effect("drops undefined optional fields so the result is valid JSON", () =>
    Effect.gen(function* () {
      const { dispatch } = compileExtensions([
        serverExtension(spec, {
          list: () => Effect.succeed({ rows: [{ name: "vercel", updateAvailable: undefined }] }),
        }),
      ]);
      const result = yield* dispatch({ extension: "test", method: "list", input: {} });
      assert.deepStrictEqual(result, { rows: [{ name: "vercel" }] });
      assert.isTrue(isJson(result));
    }),
  );
});
