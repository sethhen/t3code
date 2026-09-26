/**
 * Store folders, per-app deployments, and backups.
 *
 * A skill is deployed to an app by symlinking `<appDir>/<name>` to its store
 * folder, or, where the folder can't hold symlinks, by copying it there with a
 * `.t3code-managed` marker holding the skill id. Removal and replacement only
 * ever touch a link to the store or a copy carrying our marker. Backups mirror
 * CC Switch: `<backupDir>/<YYYYMMDD_HHMMSS>_<name>/skill/` plus `meta.json`;
 * each skill's newest backup is kept, plus the newest 20 older ones overall.
 */
import { AgentAppFlags, type AgentApp, type SkillBackup, SkillSource } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import type * as PlatformError from "effect/PlatformError";
import * as Random from "effect/Random";
import * as Schema from "effect/Schema";

import { ExtensionFailure } from "../shared/t3.ts";
import { MANAGED_MARKER, copyTree, failWith, isSymlink } from "./archive.ts";
import type { SkillsPaths } from "./store.ts";

/** Older revisions kept across all skills, beyond each skill's newest backup. */
export const MAX_BACKUPS = 20;

export type DeployMode = "symlink" | "copy";

/** What sits at `<appDir>/<name>` relative to a managed skill. */
export interface DeploymentState {
  readonly kind: "symlink" | "copy" | "none" | "foreign";
  readonly path: string;
}

interface SkillRef {
  readonly id: string;
  readonly name: string;
}

export const storeSkillDir = (path: Path.Path, paths: SkillsPaths, name: string) =>
  path.join(paths.storeDir, name);

export const appSkillDir = (path: Path.Path, paths: SkillsPaths, app: AgentApp, name: string) =>
  path.join(paths.appDirs[app], name);

const randomSuffix = Effect.map(Random.nextIntBetween(0, 0x7fffffff), (n) => n.toString(36));

/**
 * Replaces the store folder for `name` with a copy of `sourceDir`, staged next
 * to it so a failed copy leaves the old content in place.
 */
export const writeStoreSkill = Effect.fn("skillsMcp.skills.writeStoreSkill")(
  function* (paths: SkillsPaths, name: string, sourceDir: string) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    yield* fs.makeDirectory(paths.storeDir, { recursive: true });
    const staging = path.join(paths.storeDir, `.staging-${name}-${yield* randomSuffix}`);
    const target = storeSkillDir(path, paths, name);
    yield* copyTree(sourceDir, staging).pipe(
      Effect.tapError(() =>
        fs.remove(staging, { recursive: true, force: true }).pipe(Effect.ignore),
      ),
    );
    yield* fs.remove(target, { recursive: true, force: true });
    yield* fs.rename(staging, target);
    return target;
  },
  (effect, _paths, name) => Effect.mapError(effect, failWith(`Could not store skill ${name}`)),
);

const realPathOr = (fs: FileSystem.FileSystem, target: string) =>
  fs.realPath(target).pipe(Effect.orElseSucceed(() => target));

export const deploymentState = Effect.fn("skillsMcp.skills.deploymentState")(function* (
  paths: SkillsPaths,
  app: AgentApp,
  skill: SkillRef,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const at = appSkillDir(path, paths, app, skill.name);
  const link = yield* fs.readLink(at).pipe(Effect.option);
  if (Option.isSome(link)) {
    const pointsAt = path.resolve(path.dirname(at), link.value);
    const store = storeSkillDir(path, paths, skill.name);
    const ours =
      pointsAt === store || (yield* realPathOr(fs, pointsAt)) === (yield* realPathOr(fs, store));
    return { kind: ours ? "symlink" : "foreign", path: at } satisfies DeploymentState;
  }
  if (!(yield* fs.exists(at).pipe(Effect.orElseSucceed(() => false)))) {
    return { kind: "none", path: at } satisfies DeploymentState;
  }
  const marker = yield* fs
    .readFileString(path.join(at, MANAGED_MARKER))
    .pipe(Effect.orElseSucceed(() => ""));
  return {
    kind: marker.trim() === skill.id ? "copy" : "foreign",
    path: at,
  } satisfies DeploymentState;
});

const notManagedHere = (at: string) =>
  new ExtensionFailure({
    message: `${at} exists and isn't managed here; adopt or remove it first`,
  });

/**
 * Symlink errors meaning the folder can't hold symlinks (Windows without
 * Developer Mode, FAT/exFAT, some network mounts). Only these fall back to a
 * copy; `EEXIST` and everything else is reported.
 */
const SYMLINKS_UNSUPPORTED = new Set(["EPERM", "ENOTSUP", "EOPNOTSUPP", "EXDEV"]);

const symlinksUnsupported = (error: PlatformError.PlatformError) => {
  const cause = error.reason.cause;
  return (
    typeof cause === "object" &&
    cause !== null &&
    "code" in cause &&
    typeof cause.code === "string" &&
    SYMLINKS_UNSUPPORTED.has(cause.code)
  );
};

/**
 * Publishes a marked copy of the store folder at `<appDir>/<name>`: staged in
 * a sibling temp folder, then renamed into place only if the destination is
 * still absent or is our own link or copy. Anything else is left untouched
 * and reported. (rename(2) can't refuse an empty folder created in the instant
 * between the check and the rename; replacing one loses nothing.)
 */
const copyDeployment = (paths: SkillsPaths, app: AgentApp, skill: SkillRef) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const staging = path.join(
      paths.appDirs[app],
      `.${skill.name}.t3code-tmp-${yield* randomSuffix}`,
    );
    return yield* Effect.gen(function* () {
      yield* copyTree(storeSkillDir(path, paths, skill.name), staging);
      yield* fs.writeFileString(path.join(staging, MANAGED_MARKER), `${skill.id}\n`);
      const current = yield* deploymentState(paths, app, skill);
      if (current.kind === "foreign") return yield* notManagedHere(current.path);
      if (current.kind !== "none") {
        yield* fs.remove(current.path, { recursive: current.kind === "copy" });
      }
      yield* fs.rename(staging, current.path);
      return "copy" as const;
    }).pipe(
      Effect.ensuring(fs.remove(staging, { recursive: true, force: true }).pipe(Effect.ignore)),
    );
  });

/** Links (or copies) the store folder into `app`'s skills folder. */
export const deploy = Effect.fn("skillsMcp.skills.deploy")(
  function* (paths: SkillsPaths, app: AgentApp, skill: SkillRef) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const state = yield* deploymentState(paths, app, skill);
    switch (state.kind) {
      case "foreign":
        return yield* notManagedHere(state.path);
      case "symlink":
        return "symlink" as const;
      case "copy":
        return yield* copyDeployment(paths, app, skill);
      case "none": {
        yield* fs.makeDirectory(paths.appDirs[app], { recursive: true });
        const store = storeSkillDir(path, paths, skill.name);
        return yield* fs.symlink(store, state.path).pipe(
          Effect.as("symlink" as const),
          Effect.catch((error) =>
            symlinksUnsupported(error)
              ? copyDeployment(paths, app, skill)
              : Effect.fail(
                  error.reason._tag === "AlreadyExists" ? notManagedHere(state.path) : error,
                ),
          ),
        );
      }
    }
  },
  (effect, _paths, app, skill) =>
    Effect.mapError(effect, failWith(`Could not enable ${skill.name} for ${app}`)),
);

/** Removes our link or copy from `app`'s skills folder; anything else is left alone. */
export const undeploy = Effect.fn("skillsMcp.skills.undeploy")(
  function* (paths: SkillsPaths, app: AgentApp, skill: SkillRef) {
    const fs = yield* FileSystem.FileSystem;
    const state = yield* deploymentState(paths, app, skill);
    if (state.kind === "symlink") yield* fs.remove(state.path);
    if (state.kind === "copy") yield* fs.remove(state.path, { recursive: true });
    return state;
  },
  (effect, _paths, app, skill) =>
    Effect.mapError(effect, failWith(`Could not disable ${skill.name} for ${app}`)),
);

const BackupMeta = Schema.Struct({
  skill: Schema.Struct({
    name: Schema.String,
    description: Schema.optional(Schema.String),
    source: SkillSource,
    apps: AgentAppFlags,
  }),
  createdAt: Schema.String,
  sourcePath: Schema.String,
});
export type BackupMeta = typeof BackupMeta.Type;
const BackupMetaJson = Schema.fromJsonString(BackupMeta);
const decodeMeta = Schema.decodeUnknownEffect(BackupMetaJson);
const encodeMeta = Schema.encodeEffect(BackupMetaJson);

const BACKUP_ID = /^[A-Za-z0-9_.-]+$/;

const slug = (name: string) => name.replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 64) || "skill";

/** `20260926_101112` from an ISO timestamp. */
const stampOf = (iso: string) => iso.slice(0, 19).replace(/[-:]/g, "").replace("T", "_");

export interface StoredBackup {
  readonly backup: SkillBackup;
  readonly meta: BackupMeta;
  readonly dir: string;
}

/** Every readable backup, newest first. */
export const listBackups = Effect.fn("skillsMcp.skills.listBackups")(function* (
  paths: SkillsPaths,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const names = yield* fs.readDirectory(paths.backupDir).pipe(Effect.orElseSucceed(() => []));
  const backups: Array<StoredBackup> = [];
  for (const id of names) {
    if (!BACKUP_ID.test(id) || id.startsWith(".")) continue;
    const dir = path.join(paths.backupDir, id);
    const meta = yield* fs
      .readFileString(path.join(dir, "meta.json"))
      .pipe(Effect.flatMap(decodeMeta), Effect.option);
    if (Option.isNone(meta)) continue;
    backups.push({
      backup: {
        id,
        skillName: meta.value.skill.name,
        createdAt: meta.value.createdAt,
        path: path.join(dir, "skill"),
      },
      meta: meta.value,
      dir,
    });
  }
  return backups.sort((left, right) =>
    left.meta.createdAt === right.meta.createdAt
      ? right.backup.id.localeCompare(left.backup.id)
      : right.meta.createdAt.localeCompare(left.meta.createdAt),
  );
});

/**
 * Backups to prune from `all` (newest first): every skill keeps its newest
 * backup, and at most {@link MAX_BACKUPS} older revisions survive overall.
 */
const staleBackups = (all: ReadonlyArray<StoredBackup>) => {
  const seen = new Set<string>();
  let older = 0;
  return all.filter((entry) => {
    if (!seen.has(entry.meta.skill.name)) {
      seen.add(entry.meta.skill.name);
      return false;
    }
    older += 1;
    return older > MAX_BACKUPS;
  });
};

/** Copies `sourceDir` into a new backup, then prunes old revisions. */
export const createBackup = Effect.fn("skillsMcp.skills.createBackup")(
  function* (paths: SkillsPaths, skill: BackupMeta["skill"], sourceDir: string) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const createdAt = DateTime.formatIso(yield* DateTime.now);
    const base = `${stampOf(createdAt)}_${slug(skill.name)}`;
    yield* fs.makeDirectory(paths.backupDir, { recursive: true });
    let id = base;
    for (let n = 1; yield* fs.exists(path.join(paths.backupDir, id)); n++) id = `${base}_${n}`;
    const dir = path.join(paths.backupDir, id);
    yield* copyTree(sourceDir, path.join(dir, "skill"));
    const meta = yield* encodeMeta({ skill, createdAt, sourcePath: sourceDir });
    yield* fs.writeFileString(path.join(dir, "meta.json"), `${meta}\n`);
    for (const stale of staleBackups(yield* listBackups(paths))) {
      yield* fs.remove(stale.dir, { recursive: true, force: true });
    }
    return id;
  },
  (effect, _paths, skill) => Effect.mapError(effect, failWith(`Could not back up ${skill.name}`)),
);

/** A backup by id; ids are folder names, so anything path-like is refused. */
export const readBackup = Effect.fn("skillsMcp.skills.readBackup")(function* (
  paths: SkillsPaths,
  backupId: string,
) {
  if (!BACKUP_ID.test(backupId) || backupId.startsWith(".")) {
    return yield* new ExtensionFailure({ message: `Invalid backup id: ${backupId}` });
  }
  const found = (yield* listBackups(paths)).find((entry) => entry.backup.id === backupId);
  if (found === undefined) {
    return yield* new ExtensionFailure({ message: `Backup ${backupId} not found` });
  }
  return found;
});

export const deleteBackup = Effect.fn("skillsMcp.skills.deleteBackup")(
  function* (paths: SkillsPaths, backupId: string) {
    const fs = yield* FileSystem.FileSystem;
    const found = yield* readBackup(paths, backupId);
    yield* fs.remove(found.dir, { recursive: true });
  },
  (effect, _paths, backupId) =>
    Effect.mapError(effect, failWith(`Could not delete backup ${backupId}`)),
);

/** Whether `target` is a real folder holding a SKILL.md (symlinks don't count). */
export const isSkillFolder = Effect.fn("skillsMcp.skills.isSkillFolder")(function* (
  target: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  if (yield* isSymlink(target)) return false;
  const info = yield* fs.stat(path.join(target, "SKILL.md")).pipe(Effect.option);
  return Option.isSome(info) && info.value.type === "File";
});
