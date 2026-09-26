// @effect-diagnostics nodeBuiltinImport:off - sha256 hashing and zip entry buffers are Node APIs yauzl works with.
/**
 * Skill folders on disk: SKILL.md frontmatter, content hashes, tree copies
 * that keep symlinks, and zip extraction with CC Switch's guards (at most
 * 30k entries and 512 MiB, no absolute or `..` paths). Symlink entries in a
 * zip are skipped, never created.
 */
import * as NodeBuffer from "node:buffer";
import * as NodeCrypto from "node:crypto";
import * as NodeStreamConsumers from "node:stream/consumers";

import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import { parse as parseYaml } from "yaml";
import * as Yauzl from "yauzl";

import { describeCause } from "../shared/agents.ts";
import { ExtensionFailure } from "../shared/t3.ts";

export const MAX_ZIP_ENTRIES = 30_000;
export const MAX_UNCOMPRESSED_BYTES = 512 * 1024 * 1024;
const MAX_SKILL_DEPTH = 10;

/** Marks a copy-mode deployment as ours; holds the managed skill id. */
export const MANAGED_MARKER = ".t3code-managed";

/** Never copied, hashed, or treated as skill content. */
const IGNORED_NAMES = new Set([".git", ".DS_Store", "__MACOSX", MANAGED_MARKER]);

/** Wraps any failure as an `ExtensionFailure`, keeping ones that already are. */
export const failWith =
  (message: string) =>
  (cause: unknown): ExtensionFailure =>
    cause instanceof ExtensionFailure
      ? cause
      : new ExtensionFailure({ message: `${message}: ${describeCause(cause)}`, cause });

/** A folder name that is safe in every app folder, or undefined. */
export const validSkillName = (raw: string): string | undefined => {
  const name = raw.trim();
  if (name.length === 0 || name.length > 128) return undefined;
  if (name.startsWith(".") || /[/\\\0:]/.test(name)) return undefined;
  return name;
};

const FRONTMATTER = /^﻿?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;

/** `name` and `description` from SKILL.md's YAML frontmatter; empty when absent or malformed. */
export const parseSkillFrontmatter = (
  text: string,
): { readonly name?: string; readonly description?: string } => {
  const block = FRONTMATTER.exec(text)?.[1];
  if (block === undefined) return {};
  let parsed: unknown;
  try {
    parsed = parseYaml(block);
  } catch {
    return {};
  }
  if (typeof parsed !== "object" || parsed === null) return {};
  const name = "name" in parsed && typeof parsed.name === "string" ? parsed.name.trim() : "";
  const description =
    "description" in parsed && typeof parsed.description === "string"
      ? parsed.description.trim()
      : "";
  return { ...(name ? { name } : {}), ...(description ? { description } : {}) };
};

/** Frontmatter of `<dir>/SKILL.md`; empty when unreadable. */
export const readSkillInfo = (dir: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const text = yield* fs
      .readFileString(path.join(dir, "SKILL.md"))
      .pipe(Effect.orElseSucceed(() => ""));
    return parseSkillFrontmatter(text);
  });

/** True when `path` is a symlink (not followed). */
export const isSymlink = (path: string) =>
  Effect.flatMap(FileSystem.FileSystem, (fs) =>
    fs.readLink(path).pipe(
      Effect.map(() => true),
      Effect.orElseSucceed(() => false),
    ),
  );

export interface TreeEntry {
  /** Posix path relative to the walked root. */
  readonly rel: string;
  readonly abs: string;
  readonly kind: "file" | "directory" | "symlink";
  /** Symlinks only: the link text, verbatim. */
  readonly target?: string;
}

/**
 * Every entry under `root`, parents before children, without following
 * symlinks (Node's recursive readdir follows them). Skips `.git`,
 * `.DS_Store`, `__MACOSX` and the managed marker.
 */
export const walkTree = Effect.fn("skillsMcp.skills.walkTree")(function* (root: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const entries: Array<TreeEntry> = [];
  const pending: Array<string> = [""];
  while (pending.length > 0) {
    const rel = pending.pop();
    if (rel === undefined) break;
    const dir = rel === "" ? root : path.join(root, ...rel.split("/"));
    for (const name of yield* fs.readDirectory(dir)) {
      if (IGNORED_NAMES.has(name)) continue;
      const childRel = rel === "" ? name : `${rel}/${name}`;
      const abs = path.join(dir, name);
      const target = yield* fs.readLink(abs).pipe(Effect.option);
      if (Option.isSome(target)) {
        entries.push({ rel: childRel, abs, kind: "symlink", target: target.value });
        continue;
      }
      const info = yield* fs.stat(abs);
      if (info.type === "Directory") {
        entries.push({ rel: childRel, abs, kind: "directory" });
        pending.push(childRel);
      } else if (info.type === "File") {
        entries.push({ rel: childRel, abs, kind: "file" });
      }
    }
  }
  return entries.sort((left, right) => (left.rel < right.rel ? -1 : left.rel > right.rel ? 1 : 0));
});

/** Stable sha256 over relative paths, file bytes and symlink targets. */
export const hashDirectory = Effect.fn("skillsMcp.skills.hashDirectory")(
  function* (root: string) {
    const fs = yield* FileSystem.FileSystem;
    const hash = NodeCrypto.createHash("sha256");
    for (const entry of yield* walkTree(root)) {
      if (entry.kind === "file") {
        hash.update(`${entry.rel}\0`);
        hash.update(yield* fs.readFile(entry.abs));
        hash.update("\0");
      } else if (entry.kind === "symlink") {
        hash.update(`${entry.rel}\0symlink:${entry.target ?? ""}\0`);
      }
    }
    return hash.digest("hex");
  },
  (effect, root) => Effect.mapError(effect, failWith(`Could not hash ${root}`)),
);

/**
 * Copies `from` into `to` (created), keeping symlinks as symlinks. Where a
 * symlink can't be created the file or folder it points at is copied instead.
 */
export const copyTree = Effect.fn("skillsMcp.skills.copyTree")(
  function* (from: string, to: string) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    yield* fs.makeDirectory(to, { recursive: true });
    for (const entry of yield* walkTree(from)) {
      const dest = path.join(to, ...entry.rel.split("/"));
      if (entry.kind === "directory") {
        yield* fs.makeDirectory(dest, { recursive: true });
      } else if (entry.kind === "file") {
        yield* fs.copyFile(entry.abs, dest);
      } else if (entry.target !== undefined) {
        const resolved = path.resolve(path.dirname(entry.abs), entry.target);
        yield* fs
          .symlink(entry.target, dest)
          .pipe(Effect.catch(() => fs.copy(resolved, dest).pipe(Effect.ignore)));
      }
    }
  },
  (effect, from, to) => Effect.mapError(effect, failWith(`Could not copy ${from} to ${to}`)),
);

/** A zip entry name as safe posix segments, or undefined for absolute/`..`/odd paths. */
export const safeEntryPath = (name: string): string | undefined => {
  const trimmed = name.replace(/\/+$/, "");
  if (trimmed === "" || trimmed.startsWith("/") || /^[A-Za-z]:/.test(trimmed)) return undefined;
  if (trimmed.includes("\\") || trimmed.includes("\0")) return undefined;
  const segments = trimmed.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    return undefined;
  }
  return segments.join("/");
};

const invalidZip = (message: string) =>
  Effect.fail(new ExtensionFailure({ message: `Invalid zip: ${message}` }));

const isSymlinkEntry = (entry: Yauzl.Entry) =>
  ((entry.externalFileAttributes >>> 16) & 0o170000) === 0o120000;

/** Extracts `bytes` into the existing folder `destDir`, skipping symlink entries. */
export const extractZip = Effect.fn("skillsMcp.skills.extractZip")(
  function* (bytes: Uint8Array, destDir: string) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const zip = yield* Effect.acquireRelease(
      Effect.tryPromise(() =>
        Yauzl.fromBufferPromise(
          NodeBuffer.Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength),
          {
            validateEntrySizes: true,
            strictFileNames: false,
            autoClose: false,
          },
        ),
      ),
      (opened) => Effect.sync(() => opened.close()),
    );
    if (zip.entryCount > MAX_ZIP_ENTRIES) {
      return yield* invalidZip(`more than ${MAX_ZIP_ENTRIES} entries`);
    }
    const iterator = zip.eachEntry();
    let total = 0;
    while (true) {
      const next = yield* Effect.tryPromise(() => iterator.next());
      if (next.done === true) break;
      const entry = next.value;
      const rel = safeEntryPath(entry.fileName);
      if (rel === undefined) return yield* invalidZip(`unsafe path "${entry.fileName}"`);
      if (entry.isEncrypted()) return yield* invalidZip(`"${entry.fileName}" is encrypted`);
      if (isSymlinkEntry(entry)) continue;
      total += entry.uncompressedSize;
      if (total > MAX_UNCOMPRESSED_BYTES) {
        return yield* invalidZip("more than 512 MiB uncompressed");
      }
      const dest = path.join(destDir, ...rel.split("/"));
      if (entry.fileName.endsWith("/")) {
        yield* fs.makeDirectory(dest, { recursive: true });
        continue;
      }
      const content = yield* Effect.tryPromise(async () =>
        NodeStreamConsumers.buffer(await zip.openReadStreamPromise(entry)),
      );
      yield* fs.makeDirectory(path.dirname(dest), { recursive: true });
      const unixMode = (entry.externalFileAttributes >>> 16) & 0o777;
      yield* fs.writeFile(dest, content, {
        mode: unixMode === 0 ? 0o644 : (unixMode & 0o755) | 0o600,
      });
    }
  },
  (effect) =>
    Effect.mapError(Effect.scoped(effect), (cause) =>
      cause instanceof ExtensionFailure
        ? cause
        : new ExtensionFailure({ message: `Invalid zip: ${describeCause(cause)}`, cause }),
    ),
);

/**
 * GitHub zips wrap everything in `<repo>-<branch>/`; zips people make often
 * wrap in the skill's folder. Descends through one lone top-level folder.
 */
export const stripCommonRoot = Effect.fn("skillsMcp.skills.stripCommonRoot")(function* (
  dir: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const names = (yield* fs.readDirectory(dir)).filter((name) => !IGNORED_NAMES.has(name));
  const only = names.length === 1 ? names[0] : undefined;
  if (only === undefined) return { root: dir };
  const abs = path.join(dir, only);
  if (yield* isSymlink(abs)) return { root: dir };
  const info = yield* fs.stat(abs);
  return info.type === "Directory" ? { root: abs, rootName: only } : { root: dir };
});

/** Extracts into a scoped temp folder under `tmpDir` and strips the common root. */
export const extractToTemp = Effect.fn("skillsMcp.skills.extractToTemp")(
  function* (tmpDir: string, bytes: Uint8Array) {
    const fs = yield* FileSystem.FileSystem;
    yield* fs.makeDirectory(tmpDir, { recursive: true });
    const dir = yield* fs.makeTempDirectoryScoped({ directory: tmpDir, prefix: "extract-" });
    yield* extractZip(bytes, dir);
    return yield* stripCommonRoot(dir);
  },
  (effect) => Effect.mapError(effect, failWith("Could not unpack the zip")),
);

/**
 * Posix paths (relative to `root`, `""` for the root itself) of every folder
 * holding a SKILL.md. Stops descending at a skill, skips hidden, `__MACOSX`,
 * `node_modules` and symlinked folders, and goes at most ten levels deep.
 */
export const findSkillDirs = Effect.fn("skillsMcp.skills.findSkillDirs")(function* (root: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const found: Array<string> = [];
  const pending: Array<{ readonly rel: string; readonly depth: number }> = [{ rel: "", depth: 0 }];
  while (pending.length > 0) {
    const item = pending.pop();
    if (item === undefined) break;
    const dir = item.rel === "" ? root : path.join(root, ...item.rel.split("/"));
    const skillFile = yield* fs.stat(path.join(dir, "SKILL.md")).pipe(Effect.option);
    if (Option.isSome(skillFile) && skillFile.value.type === "File") {
      found.push(item.rel);
      continue;
    }
    if (item.depth >= MAX_SKILL_DEPTH) continue;
    const names = yield* fs.readDirectory(dir).pipe(Effect.orElseSucceed(() => []));
    for (const name of names) {
      if (name.startsWith(".") || name === "__MACOSX" || name === "node_modules") continue;
      const abs = path.join(dir, name);
      if (yield* isSymlink(abs)) continue;
      const info = yield* fs.stat(abs).pipe(Effect.option);
      if (Option.isSome(info) && info.value.type === "Directory") {
        pending.push({
          rel: item.rel === "" ? name : `${item.rel}/${name}`,
          depth: item.depth + 1,
        });
      }
    }
  }
  return found.sort();
});
