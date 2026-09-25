/**
 * Helpers shared by the Claude and Codex plugin adapters. File helpers never
 * fail: a missing or unreadable file is just "nothing there", because plugin
 * caches and marketplace clones come and go under the CLIs' feet.
 */
import type { PluginRow } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

export type PluginContributes = PluginRow["contributes"];

export const emptyContributes = (): PluginContributes => ({
  skills: [],
  mcpServers: [],
  commands: [],
  agents: [],
});

/** `name@marketplace` → its parts; ids without a marketplace keep the whole id as name. */
export const splitPluginId = (
  id: string,
): { readonly name: string; readonly marketplace: string | undefined } => {
  const at = id.lastIndexOf("@");
  if (at <= 0 || at === id.length - 1) return { name: id, marketplace: undefined };
  return { name: id.slice(0, at), marketplace: id.slice(at + 1) };
};

/** Trimmed, non-empty, first occurrence wins. */
export const uniqueNames = (names: Iterable<string>): string[] => {
  const seen = new Set<string>();
  for (const raw of names) {
    const name = raw.trim();
    if (name.length > 0) seen.add(name);
  }
  return [...seen];
};

export const byName = (a: PluginRow, b: PluginRow) =>
  a.name.localeCompare(b.name, undefined, { sensitivity: "base" }) || a.id.localeCompare(b.id);

/** Non-empty trimmed string, else undefined (CLIs emit `null` and `""` freely). */
export const nonEmpty = (value: string | null | undefined): string | undefined => {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
};

/** Decodes each element on its own, dropping the ones that do not match. */
export const decodeEach = <A>(
  items: ReadonlyArray<unknown> | null | undefined,
  decode: (input: unknown) => Option.Option<A>,
): A[] => (items ?? []).flatMap((item) => Option.toArray(decode(item)));

const decodeJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown));

/**
 * The JSON document a CLI printed on stdout. Tolerates banner/warning lines
 * before it by retrying from the first `[` or `{`.
 */
export const parseJsonOutput = (stdout: string): Option.Option<unknown> => {
  const text = stdout.trim();
  const whole = decodeJson(text);
  if (Option.isSome(whole)) return whole;
  const start = text.search(/[[{]/);
  return start > 0 ? decodeJson(text.slice(start)) : Option.none();
};

export const readTextFile = Effect.fn("skillsMcp.plugins.readTextFile")(function* (file: string) {
  const fs = yield* FileSystem.FileSystem;
  return yield* fs.readFileString(file).pipe(Effect.option);
});

/** Parsed JSON file, or none when missing/unreadable/invalid. */
export const readJsonFile = (file: string) =>
  readTextFile(file).pipe(Effect.map(Option.flatMap(parseJsonOutput)));

/** Entry names (dotfiles excluded) with their type; empty when the directory is missing. */
export const listDirectory = Effect.fn("skillsMcp.plugins.listDirectory")(function* (dir: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const names = yield* fs.readDirectory(dir).pipe(Effect.orElseSucceed((): string[] => []));
  return yield* Effect.forEach(
    names.filter((name) => !name.startsWith(".")).toSorted(),
    (name) =>
      fs.stat(path.join(dir, name)).pipe(
        Effect.map((info) => ({ name, type: info.type })),
        Effect.orElseSucceed(() => ({ name, type: "Unknown" as FileSystem.File.Type })),
      ),
    { concurrency: 8 },
  );
});
