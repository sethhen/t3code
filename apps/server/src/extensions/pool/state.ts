// @effect-diagnostics nodeBuiltinImport:off - the move list is a small JSON file in T3's state directory, read and written with plain Node.
/**
 * What the retired pool leaves behind: `<stateDir>/pool-move.json` (mode
 * 0600), the accounts it held that are not signed in directly yet. Provider,
 * email and plan only, never a token. The list only shrinks, and the file goes
 * once it is empty.
 */
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import type { MoveProvider } from "@t3tools/contracts";

export interface MoveEntry {
  readonly provider: MoveProvider;
  readonly email: string;
  /** Plan label, e.g. "ChatGPT Pro 20x Subscription". */
  readonly plan?: string;
}

/** The retired pool's directory (proxy binary, auth files, keys, logs). Boot deletes it. */
export const poolPaths = (stateDir: string) => {
  const root = NodePath.join(stateDir, "pool");
  return {
    root,
    configPath: NodePath.join(root, "config.yaml"),
    authDir: NodePath.join(root, "auth"),
    binDir: NodePath.join(root, "bin"),
    pidPath: NodePath.join(root, "proxy.pid"),
  };
};
export type PoolPaths = ReturnType<typeof poolPaths>;

export const moveListPath = (stateDir: string) => NodePath.join(stateDir, "pool-move.json");

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const text = (value: unknown) => (typeof value === "string" ? value.trim() : "");

export const isMissing = (error: unknown) => isRecord(error) && error.code === "ENOENT";

export const sameAccount = (a: MoveEntry, b: MoveEntry) =>
  a.provider === b.provider && a.email.toLowerCase() === b.email.toLowerCase();

/** 8 hex chars, stable per provider + email (any case). */
export const accountHash = (provider: MoveProvider, email: string) =>
  NodeCrypto.createHash("sha256")
    .update(`${provider}:${email.toLowerCase()}`)
    .digest("hex")
    .slice(0, 8);

/** `claude_1a2b3c4d`: the account's id in the contract and the id of the instance it becomes. */
export const moveAccountId = (entry: MoveEntry) =>
  `${entry.provider}_${accountHash(entry.provider, entry.email)}`;

/** The `<slug>` in `~/.claude-<slug>`: the lowercased email, other characters as "-", at most 40. */
export const emailSlug = (email: string) =>
  email
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/, "");

/** Adds `found` to `current`, keeping the first entry per provider + email. */
export const mergeMoveEntries = (
  current: ReadonlyArray<MoveEntry>,
  found: ReadonlyArray<MoveEntry>,
): MoveEntry[] => {
  const merged: MoveEntry[] = [];
  for (const entry of [...current, ...found]) {
    if (!merged.some((kept) => sameAccount(kept, entry))) merged.push(entry);
  }
  return merged;
};

/** The list on disk; a missing file is an empty list, a damaged one an error. */
export const readMoveList = async (path: string): Promise<MoveEntry[]> => {
  let raw: unknown;
  try {
    raw = JSON.parse(await NodeFSP.readFile(path, "utf8"));
  } catch (error) {
    if (isMissing(error)) return [];
    throw error;
  }
  const accounts = isRecord(raw) && Array.isArray(raw.accounts) ? raw.accounts : [];
  return accounts.flatMap((account): MoveEntry[] => {
    if (!isRecord(account)) return [];
    const provider =
      account.provider === "claude" || account.provider === "codex" ? account.provider : undefined;
    const email = text(account.email);
    const plan = text(account.plan);
    return provider && email ? [{ provider, email, ...(plan ? { plan } : {}) }] : [];
  });
};

/** Writes `value` as JSON atomically: a temp file (mode `mode`, 0600 by default) renamed over `path`. */
export const writeJsonFile = async (path: string, value: unknown, mode = 0o600) => {
  // Unique per write: concurrent saves must never share (and delete) one temp file.
  const temp = `${path}.${process.pid}.${NodeCrypto.randomUUID()}.tmp`;
  await NodeFSP.writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { mode });
  await NodeFSP.rename(temp, path);
};

/** Writes the list atomically (temp file + rename, 0600); an empty list deletes the file. */
const writeMoveList = async (path: string, entries: ReadonlyArray<MoveEntry>) => {
  if (entries.length === 0) {
    await NodeFSP.rm(path, { force: true });
    return;
  }
  await writeJsonFile(path, { version: 1, accounts: entries });
};

let writes: Promise<unknown> = Promise.resolve();

/**
 * Runs `task` after every earlier one, so two changes to the move list (boot,
 * a sign-in, a skip from another ws connection) never read the same list and
 * drop each other's write.
 */
const serialized = <A>(task: () => Promise<A>): Promise<A> => {
  const next = writes.then(task);
  writes = next.catch(() => undefined);
  return next;
};

export const updateMoveList = (
  path: string,
  change: (entries: MoveEntry[]) => ReadonlyArray<MoveEntry>,
) =>
  serialized(async () => {
    const next = change(await readMoveList(path));
    await writeMoveList(path, next);
    return next;
  });

/**
 * A JWT's payload claims. Unverified: only the email and plan are read, from
 * a token the provider's own CLI (or the retired pool) saved on this machine.
 */
export const jwtClaims = (token: unknown): Record<string, unknown> => {
  if (typeof token !== "string") return {};
  try {
    const payload: unknown = JSON.parse(
      Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8"),
    );
    return isRecord(payload) ? payload : {};
  } catch {
    return {};
  }
};

/** The account email in an OpenAI id_token. */
export const jwtEmail = (claims: Record<string, unknown>) => {
  const profile = claims["https://api.openai.com/profile"];
  return text(claims.email) || (isRecord(profile) ? text(profile.email) : "");
};

/** The ChatGPT plan slug in an OpenAI id_token (`pro`, `plus`, ...). */
export const jwtPlanType = (claims: Record<string, unknown>) => {
  const auth = claims["https://api.openai.com/auth"];
  return isRecord(auth) ? text(auth.chatgpt_plan_type) : "";
};
