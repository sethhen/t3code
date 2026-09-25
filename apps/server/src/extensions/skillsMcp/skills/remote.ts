/**
 * Network side of the skills module: GitHub repo zips from codeload (tried
 * as the given branch, then `main`, then `master`, cached for ten minutes)
 * and skills.sh search. Uses its own fetch client so callers only need the
 * extension's services.
 */
import { SkillSearchResult, type SkillRepo } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import {
  FetchHttpClient,
  HttpClient,
  HttpClientRequest,
  HttpClientResponse,
} from "effect/unstable/http";

import { ExtensionFailure } from "../shared/t3.ts";
import { extractToTemp, failWith } from "./archive.ts";
import type { SkillsPaths } from "./store.ts";

const MAX_DOWNLOAD_BYTES = 128 * 1024 * 1024;
const DOWNLOAD_TIMEOUT = Duration.seconds(60);
const SEARCH_TIMEOUT = Duration.seconds(10);
const CACHE_TTL_MS = 10 * 60_000;
const CACHE_MAX_ENTRIES = 8;
const CACHE_MAX_BLOB_BYTES = 32 * 1024 * 1024;
const SEARCH_URL = "https://skills.sh/api/search";

const GITHUB_NAME = /^[A-Za-z0-9_.-]+$/;

/** A GitHub owner or repo name, or undefined. */
export const validGithubName = (raw: string): string | undefined => {
  const name = raw.trim();
  return GITHUB_NAME.test(name) && name !== "." && name !== ".." ? name : undefined;
};

/** Branches to try, in order: the given one (unless empty or `HEAD`), then `main`, then `master`. */
export const branchCandidates = (branch: string | undefined): ReadonlyArray<string> => {
  const given = branch?.trim();
  const candidates = given && given !== "HEAD" ? [given, "main", "master"] : ["main", "master"];
  return [...new Set(candidates)];
};

const codeloadUrl = (owner: string, repo: string, branch: string) =>
  `https://codeload.github.com/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/zip/refs/heads/${branch
    .split("/")
    .map(encodeURIComponent)
    .join("/")}`;

const fetchZip = Effect.fn("skillsMcp.skills.fetchZip")(
  function* (url: string) {
    const http = yield* HttpClient.HttpClient;
    const response = yield* http
      .execute(HttpClientRequest.get(url))
      .pipe(Effect.flatMap(HttpClientResponse.filterStatusOk));
    const chunks: Array<Uint8Array> = [];
    let size = 0;
    yield* Stream.runForEach(response.stream, (chunk) => {
      size += chunk.byteLength;
      if (size > MAX_DOWNLOAD_BYTES) {
        return Effect.fail(new ExtensionFailure({ message: "Download is larger than 128 MiB" }));
      }
      chunks.push(chunk);
      return Effect.void;
    });
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return bytes;
  },
  (effect, url) =>
    effect.pipe(
      Effect.timeoutOrElse({
        duration: DOWNLOAD_TIMEOUT,
        orElse: () =>
          Effect.fail(new ExtensionFailure({ message: `Timed out downloading ${url}` })),
      }),
      Effect.provide(FetchHttpClient.layer),
      Effect.mapError(failWith(`Could not download ${url}`)),
    ),
);

const zipCache = new Map<string, { readonly at: number; readonly bytes: Uint8Array }>();

const cachedZip = (key: string, now: number) => {
  const hit = zipCache.get(key);
  if (hit === undefined) return undefined;
  if (now - hit.at < CACHE_TTL_MS) return hit.bytes;
  zipCache.delete(key);
  return undefined;
};

const rememberZip = (key: string, at: number, bytes: Uint8Array) => {
  if (bytes.byteLength > CACHE_MAX_BLOB_BYTES) return;
  zipCache.delete(key);
  zipCache.set(key, { at, bytes });
  while (zipCache.size > CACHE_MAX_ENTRIES) {
    const oldest = zipCache.keys().next();
    if (oldest.done === true) break;
    zipCache.delete(oldest.value);
  }
};

/** The repo's zip and the branch it came from. */
export const downloadRepo = Effect.fn("skillsMcp.skills.downloadRepo")(function* (repo: SkillRepo) {
  const owner = validGithubName(repo.owner);
  const name = validGithubName(repo.repo);
  if (owner === undefined || name === undefined) {
    return yield* new ExtensionFailure({
      message: `Not a GitHub repo: ${repo.owner}/${repo.repo}`,
    });
  }
  const candidates = branchCandidates(repo.branch);
  const errors: Array<string> = [];
  for (const branch of candidates) {
    const key = `${owner}/${name}@${branch}`.toLowerCase();
    const now = yield* Clock.currentTimeMillis;
    const cached = cachedZip(key, now);
    if (cached !== undefined) return { bytes: cached, branch };
    const result = yield* Effect.result(fetchZip(codeloadUrl(owner, name, branch)));
    if (Result.isSuccess(result)) {
      rememberZip(key, now, result.success);
      return { bytes: result.success, branch };
    }
    errors.push(`${branch}: ${result.failure.message}`);
  }
  return yield* new ExtensionFailure({
    message: `Could not download ${owner}/${name} (tried ${candidates.join(", ")}): ${errors.at(-1) ?? ""}`,
  });
});

/** Downloads and unpacks `repo` into a temp folder that lives as long as `use`. */
export const withRepoCheckout = <A, R>(
  paths: SkillsPaths,
  repo: SkillRepo,
  use: (checkout: {
    readonly root: string;
    readonly branch: string;
  }) => Effect.Effect<A, ExtensionFailure, R>,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const { bytes, branch } = yield* downloadRepo(repo);
      const { root } = yield* extractToTemp(paths.tmpDir, bytes);
      return yield* use({ root, branch });
    }),
  );

const SearchBody = Schema.Struct({ skills: Schema.Array(Schema.Unknown) });
const isSearchResult = Schema.is(SkillSearchResult);
const SOURCE = /^[\w.-]+\/[\w.-]+$/;

/** skills.sh search; results whose source isn't an `owner/repo` are dropped. */
export const searchSkillsSh = Effect.fn("skillsMcp.skills.searchSkillsSh")(
  function* (query: string, limit: number | undefined) {
    const q = query.trim();
    if (q.length === 0) return [];
    const count = Math.min(100, Math.max(1, Math.trunc(limit ?? 20)));
    const http = yield* HttpClient.HttpClient;
    const response = yield* http
      .execute(HttpClientRequest.get(SEARCH_URL, { urlParams: { q, limit: String(count) } }))
      .pipe(Effect.flatMap(HttpClientResponse.filterStatusOk));
    const body = yield* HttpClientResponse.schemaBodyJson(SearchBody)(response);
    return body.skills.filter(isSearchResult).filter((skill) => SOURCE.test(skill.source));
  },
  (effect) =>
    effect.pipe(
      Effect.timeoutOrElse({
        duration: SEARCH_TIMEOUT,
        orElse: () => Effect.fail(new ExtensionFailure({ message: "skills.sh search timed out" })),
      }),
      Effect.provide(FetchHttpClient.layer),
      Effect.mapError(failWith("skills.sh search failed")),
    ),
);
