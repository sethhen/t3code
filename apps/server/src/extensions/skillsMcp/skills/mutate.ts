/**
 * `skills.mutate`: every store change. Document edits run under the
 * `skills.json` lock; downloads happen before taking it. Per-app deploy
 * failures are reported in `failures` rather than failing the call.
 */
import {
  AGENT_APPS,
  type AgentApp,
  type AgentAppFlags,
  type MutationResult,
  type SkillSource,
  type SkillsMutation,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Encoding from "effect/Encoding";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Random from "effect/Random";
import * as Result from "effect/Result";

import { invalidateAgentProbes } from "../mcp/probes.ts";
import { ExtensionFailure } from "../shared/t3.ts";
import {
  copyTree,
  extractToTemp,
  failWith,
  findSkillDirs,
  hashDirectory,
  readSkillInfo,
  validSkillName,
} from "./archive.ts";
import {
  type BackupMeta,
  createBackup,
  deleteBackup,
  deploy,
  isSkillFolder,
  readBackup,
  storeSkillDir,
  undeploy,
  writeStoreSkill,
} from "./deploy.ts";
import { setAppEnabled } from "./native.ts";
import { validGithubName, withRepoCheckout } from "./remote.ts";
import {
  type ManagedSkill,
  type SkillsDocument,
  type SkillsPaths,
  resolveSkillsPaths,
  skillsDocument,
} from "./store.ts";

type Failure = MutationResult["failures"][number];
type Mutation<A extends SkillsMutation["action"]> = Extract<SkillsMutation, { action: A }>;

/** Base64 uploads above this are refused before decoding. */
const MAX_ZIP_UPLOAD_BYTES = 128 * 1024 * 1024;

const APP_LABEL: Record<AgentApp, string> = { claude: "Claude", codex: "Codex" };

const done = (failures: ReadonlyArray<Failure>, message?: string): MutationResult => ({
  failures,
  ...(message !== undefined ? { message } : {}),
});

const fail = (message: string) => Effect.fail(new ExtensionFailure({ message }));

const sameName = (left: string, right: string) => left.toLowerCase() === right.toLowerCase();

const newId = Effect.gen(function* () {
  const high = yield* Random.nextIntBetween(0, 0x7fffffff);
  const low = yield* Random.nextIntBetween(0, 0x7fffffff);
  return `sk_${high.toString(36)}${low.toString(36)}`;
});

const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

const realPathOr = (target: string) =>
  Effect.flatMap(FileSystem.FileSystem, (fs) =>
    fs.realPath(target).pipe(Effect.orElseSucceed(() => target)),
  );

const exists = (target: string) =>
  Effect.flatMap(FileSystem.FileSystem, (fs) =>
    fs.exists(target).pipe(Effect.orElseSucceed(() => false)),
  );

const replaceSkill = (doc: SkillsDocument, skill: ManagedSkill): SkillsDocument => ({
  ...doc,
  skills: doc.skills.map((entry) => (entry.id === skill.id ? skill : entry)),
});

const findSkill = (doc: SkillsDocument, id: string) =>
  Effect.gen(function* () {
    const skill = doc.skills.find((entry) => entry.id === id);
    if (skill === undefined) return yield* fail("Skill not found; refresh and try again");
    return skill;
  });

const backupInfo = (skill: ManagedSkill): BackupMeta["skill"] => ({
  name: skill.name,
  ...(skill.description !== undefined ? { description: skill.description } : {}),
  source: skill.source,
  apps: skill.apps,
});

/** `a/b/c` → `c`; the root (`""`) → `fallback`. */
const lastSegment = (rel: string, fallback: string) => rel.split("/").at(-1) || fallback;

const joinRel = (path: Path.Path, root: string, rel: string) =>
  rel === "" ? root : path.join(root, ...rel.split("/"));

/** Deploys to every app flagged in `apps`; failures are collected per app. */
const deployApps = (
  paths: SkillsPaths,
  skill: { readonly id: string; readonly name: string },
  apps: AgentAppFlags,
) =>
  Effect.gen(function* () {
    const deployed = { claude: false, codex: false };
    const failures: Array<Failure> = [];
    for (const app of AGENT_APPS) {
      if (!apps[app]) continue;
      const attempt = yield* Effect.result(deploy(paths, app, skill));
      if (Result.isSuccess(attempt)) deployed[app] = true;
      else failures.push({ app, message: attempt.failure.message });
    }
    return { deployed: deployed satisfies AgentAppFlags, failures };
  });

/** Copies `sourceDir` into the store and deploys it; run inside a document update. */
const addSkill = (
  paths: SkillsPaths,
  input: {
    readonly name: string;
    readonly sourceDir: string;
    readonly source: SkillSource;
    readonly apps: AgentAppFlags;
  },
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const info = yield* readSkillInfo(input.sourceDir);
    const id = yield* newId;
    const stored = yield* writeStoreSkill(paths, input.name, input.sourceDir);
    const hash = yield* hashDirectory(stored).pipe(
      Effect.tapError(() =>
        fs.remove(stored, { recursive: true, force: true }).pipe(Effect.ignore),
      ),
    );
    const { deployed, failures } = yield* deployApps(paths, { id, name: input.name }, input.apps);
    const skill: ManagedSkill = {
      id,
      name: input.name,
      ...(info.description !== undefined ? { description: info.description } : {}),
      source: input.source,
      installedAt: yield* nowIso,
      hash,
      apps: deployed,
    };
    return { skill, failures };
  });

/** Posix, no leading/trailing slashes; undefined when it climbs out with `..`. */
const normalizeRel = (raw: string) => {
  const segments = raw
    .trim()
    .replace(/\\/g, "/")
    .split("/")
    .filter((segment) => segment !== "" && segment !== ".");
  return segments.includes("..") ? undefined : segments.join("/");
};

/**
 * The skill folder `install` means: `source.path` (exactly, or the one skill
 * under it), narrowed by `skillName` (folder or frontmatter name), else the
 * repo's only skill.
 */
const pickSkillDir = (
  root: string,
  dirs: ReadonlyArray<string>,
  where: {
    readonly label: string;
    readonly path?: string | undefined;
    readonly skillName?: string | undefined;
  },
) =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    let candidates = dirs;
    if (where.path !== undefined) {
      const prefix = normalizeRel(where.path);
      if (prefix === undefined) return yield* fail(`Invalid path in ${where.label}: ${where.path}`);
      if (dirs.includes(prefix)) return prefix;
      candidates = prefix === "" ? dirs : dirs.filter((dir) => dir.startsWith(`${prefix}/`));
    }
    const wanted = where.skillName?.trim();
    if (wanted) {
      const byFolder = candidates.filter((dir) => sameName(lastSegment(dir, ""), wanted));
      const matches: Array<string> = [...byFolder];
      if (matches.length === 0) {
        for (const dir of candidates) {
          const info = yield* readSkillInfo(joinRel(path, root, dir));
          if (info.name !== undefined && sameName(info.name, wanted)) matches.push(dir);
        }
      }
      const shallowest = matches.sort(
        (left, right) =>
          left.split("/").length - right.split("/").length || left.localeCompare(right),
      )[0];
      if (shallowest === undefined)
        return yield* fail(`No skill named ${wanted} in ${where.label}`);
      return shallowest;
    }
    const only = candidates.length === 1 ? candidates[0] : undefined;
    if (only !== undefined) return only;
    return yield* fail(
      candidates.length === 0
        ? `No SKILL.md found in ${where.label}`
        : `${where.label} holds ${candidates.length} skills; pick one`,
    );
  });

const install = Effect.fn("skillsMcp.skills.install")(function* (
  paths: SkillsPaths,
  input: Mutation<"install">,
) {
  const path = yield* Path.Path;
  const owner = validGithubName(input.source.owner);
  const repo = validGithubName(input.source.repo);
  if (owner === undefined || repo === undefined) {
    return yield* fail(`Not a GitHub repo: ${input.source.owner}/${input.source.repo}`);
  }
  const label = `${owner}/${repo}`;
  const requested = input.source.branch?.trim();
  return yield* withRepoCheckout(
    paths,
    { owner, repo, ...(requested ? { branch: requested } : {}) },
    ({ root, branch }) =>
      Effect.gen(function* () {
        const dirs = yield* findSkillDirs(root);
        const rel = yield* pickSkillDir(root, dirs, {
          label,
          path: input.source.path,
          skillName: input.skillName,
        });
        const rawName = lastSegment(rel, repo);
        const name = validSkillName(rawName);
        if (name === undefined) return yield* fail(`Invalid skill name: ${rawName}`);
        const source: SkillSource = {
          type: "github",
          owner,
          repo,
          // The requested branch, or the default (`main`/`master`) it resolved to when none was given.
          branch,
          ...(rel !== "" ? { path: rel } : {}),
        };
        return yield* skillsDocument.update((doc) =>
          Effect.gen(function* () {
            if (doc.skills.some((skill) => sameName(skill.name, name))) {
              return yield* fail(`${name} is already installed; use update instead`);
            }
            const added = yield* addSkill(paths, {
              name,
              sourceDir: joinRel(path, root, rel),
              source,
              apps: input.apps,
            });
            return [
              done(added.failures, `Installed ${name}`),
              { ...doc, skills: [...doc.skills, added.skill] },
            ] as const;
          }),
        );
      }),
  );
});

const installZip = Effect.fn("skillsMcp.skills.installZip")(function* (
  paths: SkillsPaths,
  input: Mutation<"installZip">,
) {
  const path = yield* Path.Path;
  const data = input.dataBase64.replace(/^data:[^,]*,/, "").trim();
  if (Math.floor((data.length * 3) / 4) > MAX_ZIP_UPLOAD_BYTES) {
    return yield* fail(`${input.fileName} is larger than 128 MiB`);
  }
  const bytes = Encoding.decodeBase64(data);
  if (!Result.isSuccess(bytes)) return yield* fail(`${input.fileName}: invalid base64 data`);
  const fileBase = path.basename(input.fileName).replace(/\.zip$/i, "");
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const { root, rootName } = yield* extractToTemp(paths.tmpDir, bytes.success);
      const dirs = yield* findSkillDirs(root);
      if (dirs.length === 0) return yield* fail(`No SKILL.md in ${input.fileName}`);
      return yield* skillsDocument.update((doc) =>
        Effect.gen(function* () {
          const failures: Array<Failure> = [];
          const added: Array<ManagedSkill> = [];
          for (const rel of dirs) {
            const rawName = rel === "" ? (rootName ?? fileBase) : lastSegment(rel, fileBase);
            const name = validSkillName(rawName);
            if (name === undefined) {
              failures.push({ message: `Invalid skill name: ${rawName}` });
              continue;
            }
            if ([...doc.skills, ...added].some((skill) => sameName(skill.name, name))) {
              failures.push({ message: `${name} is already installed` });
              continue;
            }
            const attempt = yield* Effect.result(
              addSkill(paths, {
                name,
                sourceDir: joinRel(path, root, rel),
                source: { type: "zip", fileName: input.fileName },
                apps: input.apps,
              }),
            );
            if (!Result.isSuccess(attempt)) {
              failures.push({ message: attempt.failure.message });
              continue;
            }
            added.push(attempt.success.skill);
            failures.push(...attempt.success.failures);
          }
          const message =
            added.length === 0
              ? `Nothing installed from ${input.fileName}`
              : `Installed ${added.map((skill) => skill.name).join(", ")}`;
          return [done(failures, message), { ...doc, skills: [...doc.skills, ...added] }] as const;
        }),
      );
    }),
  );
});

const setEnabled = (paths: SkillsPaths, input: Mutation<"setEnabled">) =>
  skillsDocument.update((doc) =>
    Effect.gen(function* () {
      const skill = yield* findSkill(doc, input.id);
      const attempt = yield* Effect.result(
        input.enabled
          ? Effect.asVoid(deploy(paths, input.app, skill))
          : Effect.asVoid(undeploy(paths, input.app, skill)),
      );
      if (!Result.isSuccess(attempt)) {
        return [done([{ app: input.app, message: attempt.failure.message }]), doc] as const;
      }
      const apps: AgentAppFlags = { ...skill.apps, [input.app]: input.enabled };
      return [
        done(
          [],
          `${input.enabled ? "Enabled" : "Disabled"} ${skill.name} for ${APP_LABEL[input.app]}`,
        ),
        replaceSkill(doc, { ...skill, apps }),
      ] as const;
    }),
  );

const uninstall = (paths: SkillsPaths, input: Mutation<"uninstall">) =>
  skillsDocument.update((doc) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const skill = yield* findSkill(doc, input.id);
      const store = storeSkillDir(path, paths, skill.name);
      const backupId = (yield* exists(store))
        ? yield* createBackup(paths, backupInfo(skill), store)
        : undefined;
      const apps = { ...skill.apps };
      const failures: Array<Failure> = [];
      for (const app of AGENT_APPS) {
        const attempt = yield* Effect.result(undeploy(paths, app, skill));
        if (Result.isSuccess(attempt)) apps[app] = false;
        else failures.push({ app, message: attempt.failure.message });
      }
      if (failures.length > 0) {
        return [
          done(failures, `${skill.name} is still deployed somewhere, so it stays in the store`),
          replaceSkill(doc, { ...skill, apps }),
        ] as const;
      }
      yield* fs.remove(store, { recursive: true, force: true });
      return [
        done(
          [],
          `Uninstalled ${skill.name}${backupId !== undefined ? ` (backup ${backupId})` : ""}`,
        ),
        { ...doc, skills: doc.skills.filter((entry) => entry.id !== skill.id) },
      ] as const;
    }),
  );

type GithubSource = Extract<SkillSource, { type: "github" }>;
type GithubSkill = ManagedSkill & { readonly source: GithubSource };

const isGithubSkill = (skill: ManagedSkill): skill is GithubSkill => skill.source.type === "github";

/** Github skills grouped by the checkout they come from. */
const byCheckout = (skills: ReadonlyArray<GithubSkill>) => {
  const groups = new Map<string, Array<GithubSkill>>();
  for (const skill of skills) {
    const { owner, repo, branch } = skill.source;
    // GitHub owner and repo names are case-insensitive; branch names are not.
    const key = `${owner.toLowerCase()}/${repo.toLowerCase()}@${branch ?? ""}`;
    groups.set(key, [...(groups.get(key) ?? []), skill]);
  }
  return [...groups.values()].flatMap((group) => {
    const first = group[0];
    return first === undefined ? [] : [{ source: first.source, skills: group }];
  });
};

/** The skill's folder inside a checkout, if it still holds a SKILL.md. */
const sourceDirIn = (root: string, skill: GithubSkill) =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const rel = normalizeRel(skill.source.path ?? "");
    const dir = rel === undefined ? undefined : joinRel(path, root, rel);
    if (dir === undefined || !(yield* exists(path.join(dir, "SKILL.md")))) {
      const { owner, repo } = skill.source;
      return yield* fail(
        `${skill.name}: ${skill.source.path || "the repo root"} no longer has a SKILL.md in ${owner}/${repo}`,
      );
    }
    return dir;
  });

const checkoutOf = (source: GithubSource) => ({
  owner: source.owner,
  repo: source.repo,
  ...(source.branch !== undefined ? { branch: source.branch } : {}),
});

const checkUpdates = Effect.fn("skillsMcp.skills.checkUpdates")(function* (paths: SkillsPaths) {
  const doc = yield* skillsDocument.read;
  const failures: Array<Failure> = [];
  const hashes = new Map<string, string>();
  for (const group of byCheckout(doc.skills.filter(isGithubSkill))) {
    const checked = yield* Effect.result(
      withRepoCheckout(paths, checkoutOf(group.source), ({ root }) =>
        Effect.gen(function* () {
          for (const skill of group.skills) {
            const hash = yield* Effect.result(
              Effect.flatMap(sourceDirIn(root, skill), hashDirectory),
            );
            if (Result.isSuccess(hash)) hashes.set(skill.id, hash.success);
            else failures.push({ message: hash.failure.message });
          }
        }),
      ),
    );
    if (!Result.isSuccess(checked)) {
      failures.push({
        message: `${group.source.owner}/${group.source.repo}: ${checked.failure.message}`,
      });
    }
  }
  return yield* skillsDocument.update((current) =>
    Effect.sync(() => {
      const skills = current.skills.map((skill) => {
        const hash = hashes.get(skill.id);
        return hash === undefined ? skill : { ...skill, updateAvailable: hash !== skill.hash };
      });
      const count = skills.filter((skill) => skill.updateAvailable === true).length;
      const message =
        count === 0
          ? "All skills are up to date"
          : `${count} update${count === 1 ? "" : "s"} available`;
      return [done(failures, message), { ...current, skills }] as const;
    }),
  );
});

interface UpdateOutcome {
  readonly updated: string | undefined;
  readonly failures: ReadonlyArray<Failure>;
}

/** Replaces one skill's store folder with the checkout's copy (after a backup) and redeploys. */
const updateOne = (paths: SkillsPaths, root: string, branch: string, id: string) =>
  skillsDocument.update((doc) =>
    Effect.gen(function* () {
      const skill = doc.skills.find((entry) => entry.id === id);
      if (skill === undefined || !isGithubSkill(skill)) {
        const skipped: UpdateOutcome = { updated: undefined, failures: [] };
        return [skipped, doc] as const;
      }
      const path = yield* Path.Path;
      const sourceDir = yield* sourceDirIn(root, skill);
      const store = storeSkillDir(path, paths, skill.name);
      if (yield* exists(store)) yield* createBackup(paths, backupInfo(skill), store);
      const stored = yield* writeStoreSkill(paths, skill.name, sourceDir);
      const hash = yield* hashDirectory(stored);
      const info = yield* readSkillInfo(sourceDir);
      const { deployed, failures } = yield* deployApps(paths, skill, skill.apps);
      const description = info.description ?? skill.description;
      const next: ManagedSkill = {
        id: skill.id,
        name: skill.name,
        ...(description !== undefined ? { description } : {}),
        // Keeps the stored branch; one resolved from `main`/`master` fills it in only when none was stored.
        source: { ...skill.source, branch: skill.source.branch ?? branch },
        installedAt: skill.installedAt,
        hash,
        apps: {
          claude: skill.apps.claude && deployed.claude,
          codex: skill.apps.codex && deployed.codex,
        },
        updateAvailable: false,
      };
      const outcome: UpdateOutcome = { updated: skill.name, failures };
      return [outcome, replaceSkill(doc, next)] as const;
    }),
  );

const update = Effect.fn("skillsMcp.skills.update")(function* (
  paths: SkillsPaths,
  input: Mutation<"update">,
) {
  const doc = yield* skillsDocument.read;
  const targets =
    input.id !== undefined
      ? [yield* findSkill(doc, input.id)]
      : doc.skills.filter((skill) => skill.updateAvailable === true);
  if (targets.length === 0) return done([], "No updates available");
  const failures: Array<Failure> = targets
    .filter((skill) => !isGithubSkill(skill))
    .map((skill) => ({
      message: `${skill.name} wasn't installed from GitHub; reinstall it to update`,
    }));
  const updated: Array<string> = [];
  for (const group of byCheckout(targets.filter(isGithubSkill))) {
    const attempt = yield* Effect.result(
      withRepoCheckout(paths, checkoutOf(group.source), ({ root, branch }) =>
        Effect.gen(function* () {
          for (const skill of group.skills) {
            const one = yield* Effect.result(updateOne(paths, root, branch, skill.id));
            if (!Result.isSuccess(one)) {
              failures.push({ message: one.failure.message });
              continue;
            }
            if (one.success.updated !== undefined) updated.push(one.success.updated);
            failures.push(...one.success.failures);
          }
        }),
      ),
    );
    if (!Result.isSuccess(attempt)) {
      failures.push({
        message: `${group.source.owner}/${group.source.repo}: ${attempt.failure.message}`,
      });
    }
  }
  return done(failures, updated.length === 0 ? "Nothing updated" : `Updated ${updated.join(", ")}`);
});

const restoreBackup = Effect.fn("skillsMcp.skills.restoreBackup")(function* (
  paths: SkillsPaths,
  input: Mutation<"restoreBackup">,
) {
  const found = yield* readBackup(paths, input.backupId);
  const meta = found.meta.skill;
  const restoredName = validSkillName(meta.name);
  if (restoredName === undefined) return yield* fail(`Invalid skill name in backup: ${meta.name}`);
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      // Staged first: backing up the current folder may prune this backup.
      yield* fs.makeDirectory(paths.tmpDir, { recursive: true });
      const staged = path.join(
        yield* fs.makeTempDirectoryScoped({ directory: paths.tmpDir, prefix: "restore-" }),
        "skill",
      );
      yield* copyTree(found.backup.path, staged);
      return yield* skillsDocument.update((doc) =>
        Effect.gen(function* () {
          const existing = doc.skills.find((skill) => sameName(skill.name, restoredName));
          const name = existing?.name ?? restoredName;
          const store = storeSkillDir(path, paths, name);
          if (yield* exists(store)) {
            yield* createBackup(paths, existing ? backupInfo(existing) : { ...meta, name }, store);
          }
          const stored = yield* writeStoreSkill(paths, name, staged);
          const hash = yield* hashDirectory(stored);
          const id = existing?.id ?? (yield* newId);
          const apps = {
            claude: meta.apps.claude || existing?.apps.claude === true,
            codex: meta.apps.codex || existing?.apps.codex === true,
          };
          const { deployed, failures } = yield* deployApps(paths, { id, name }, apps);
          const description = meta.description ?? (yield* readSkillInfo(stored)).description;
          const skill: ManagedSkill = {
            id,
            name,
            ...(description !== undefined ? { description } : {}),
            source: meta.source,
            installedAt: existing?.installedAt ?? (yield* nowIso),
            hash,
            apps: deployed,
          };
          const skills = existing
            ? doc.skills.map((entry) => (entry.id === existing.id ? skill : entry))
            : [...doc.skills, skill];
          return [
            done(failures, `Restored ${name} from ${input.backupId}`),
            { ...doc, skills },
          ] as const;
        }),
      );
    }),
  );
});

/**
 * Takes an unmanaged skill folder from Claude's or Codex's skills folder:
 * backs up every same-named copy in either app folder, moves the chosen one
 * into the store, removes the others, and links it back into each app that
 * had a copy (plus any requested in `apps`).
 */
const adopt = Effect.fn("skillsMcp.skills.adopt")(function* (
  paths: SkillsPaths,
  input: Mutation<"adopt">,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const raw = input.path.trim();
  const given = path.basename(raw) === "SKILL.md" ? path.dirname(raw) : raw;
  if (!path.isAbsolute(given)) return yield* fail(`Adopt needs an absolute path: ${input.path}`);
  const target = path.resolve(given);
  const name = validSkillName(path.basename(target));
  if (name === undefined) return yield* fail(`Invalid skill name: ${path.basename(target)}`);
  const parents = new Set([path.dirname(target), yield* realPathOr(path.dirname(target))]);
  let inAppDir = false;
  for (const app of AGENT_APPS) {
    const dirs = [paths.appDirs[app], yield* realPathOr(paths.appDirs[app])];
    if (dirs.some((dir) => parents.has(dir))) inAppDir = true;
  }
  if (!inAppDir)
    return yield* fail(`${target} isn't directly in the Claude or Codex skills folder`);
  if (!(yield* isSkillFolder(target))) {
    return yield* fail(`${target} isn't a skill folder (no SKILL.md, or it's a link)`);
  }
  const targetReal = yield* realPathOr(target);

  return yield* skillsDocument.update((doc) =>
    Effect.gen(function* () {
      if (doc.skills.some((skill) => sameName(skill.name, name))) {
        return yield* fail(`${name} is already managed`);
      }
      const hadCopy = { claude: false, codex: false };
      const copies = new Map<string, string>();
      for (const app of AGENT_APPS) {
        const dir = path.join(paths.appDirs[app], name);
        if (!(yield* isSkillFolder(dir))) continue;
        hadCopy[app] = true;
        const real = yield* realPathOr(dir);
        if (!copies.has(real)) copies.set(real, dir);
      }
      if (!copies.has(targetReal)) copies.set(targetReal, target);
      const info = yield* readSkillInfo(target);
      const backups: Array<string> = [];
      for (const dir of copies.values()) {
        backups.push(
          yield* createBackup(
            paths,
            {
              name,
              ...(info.description !== undefined ? { description: info.description } : {}),
              source: { type: "local", path: dir },
              apps: hadCopy,
            },
            dir,
          ),
        );
      }
      const hash = yield* hashDirectory(target);
      const store = storeSkillDir(path, paths, name);
      yield* fs.makeDirectory(paths.storeDir, { recursive: true });
      yield* fs.remove(store, { recursive: true, force: true });
      yield* fs
        .rename(target, store)
        .pipe(
          Effect.catch(() =>
            copyTree(target, store).pipe(Effect.andThen(fs.remove(target, { recursive: true }))),
          ),
        );
      for (const [real, dir] of copies) {
        if (real !== targetReal) yield* fs.remove(dir, { recursive: true });
      }
      const id = yield* newId;
      const { deployed, failures } = yield* deployApps(
        paths,
        { id, name },
        {
          claude: input.apps.claude || hadCopy.claude,
          codex: input.apps.codex || hadCopy.codex,
        },
      );
      const skill: ManagedSkill = {
        id,
        name,
        ...(info.description !== undefined ? { description: info.description } : {}),
        source: { type: "local", path: target },
        installedAt: yield* nowIso,
        hash,
        apps: deployed,
      };
      return [
        done(
          failures,
          `Adopted ${name} (backed up ${backups.length} ${backups.length === 1 ? "copy" : "copies"})`,
        ),
        { ...doc, skills: [...doc.skills, skill] },
      ] as const;
    }),
  );
});

const sameRepo = (
  entry: { readonly owner: string; readonly repo: string },
  owner: string,
  repo: string,
) => sameName(entry.owner, owner) && sameName(entry.repo, repo);

const addRepo = Effect.fn("skillsMcp.skills.addRepo")(function* (input: Mutation<"addRepo">) {
  const owner = validGithubName(input.owner);
  const repo = validGithubName(input.repo);
  if (owner === undefined || repo === undefined) {
    return yield* fail(`Not a GitHub repo: ${input.owner}/${input.repo}`);
  }
  const branch = input.branch?.trim();
  const entry = { owner, repo, ...(branch ? { branch } : {}) };
  return yield* skillsDocument.update((doc) =>
    Effect.sync(() => {
      const known = doc.repos.some((existing) => sameRepo(existing, owner, repo));
      const repos = known
        ? doc.repos.map((existing) => (sameRepo(existing, owner, repo) ? entry : existing))
        : [...doc.repos, entry];
      return [
        done([], `${known ? "Updated" : "Added"} ${owner}/${repo}`),
        { ...doc, repos },
      ] as const;
    }),
  );
});

const removeRepo = (input: Mutation<"removeRepo">) =>
  skillsDocument.update((doc) =>
    Effect.sync(() => {
      const repos = doc.repos.filter(
        (entry) => !sameRepo(entry, input.owner.trim(), input.repo.trim()),
      );
      const label = `${input.owner}/${input.repo}`;
      return [
        done(
          [],
          repos.length === doc.repos.length ? `${label} wasn't in the list` : `Removed ${label}`,
        ),
        { ...doc, repos },
      ] as const;
    }),
  );

/**
 * Runs one `skills.mutate` action against the store, then drops the cached
 * agent probes so the next one sees the changed skills.
 */
export const mutate = Effect.fn("skillsMcp.skills.mutate")(
  function* (input: SkillsMutation) {
    const { paths, clis } = yield* resolveSkillsPaths;
    switch (input.action) {
      case "install":
        return yield* install(paths, input);
      case "installZip":
        return yield* installZip(paths, input);
      case "setEnabled":
        return yield* setEnabled(paths, input);
      case "setAppEnabled":
        return yield* setAppEnabled(clis, input);
      case "uninstall":
        return yield* uninstall(paths, input);
      case "checkUpdates":
        return yield* checkUpdates(paths);
      case "update":
        return yield* update(paths, input);
      case "restoreBackup":
        return yield* restoreBackup(paths, input);
      case "deleteBackup":
        yield* deleteBackup(paths, input.backupId);
        return done([], `Deleted backup ${input.backupId}`);
      case "adopt":
        return yield* adopt(paths, input);
      case "addRepo":
        return yield* addRepo(input);
      case "removeRepo":
        return yield* removeRepo(input);
    }
  },
  (effect, input) =>
    effect.pipe(
      Effect.ensuring(invalidateAgentProbes),
      Effect.mapError(failWith(`Skills ${input.action} failed`)),
    ),
);
