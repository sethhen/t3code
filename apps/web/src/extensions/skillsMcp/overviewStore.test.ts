import { beforeEach, describe, expect, it } from "vite-plus/test";

import type { ExtensionCallOutcome } from "../client";
import { loadOverview, readOverview, resetOverviews, subscribeOverview } from "./overviewStore";

type Outcome = ExtensionCallOutcome<unknown>;

function deferred() {
  let resolve!: (outcome: Outcome) => void;
  const promise = new Promise<Outcome>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const ok = (value: unknown): Outcome => ({ ok: true, value });

beforeEach(() => resetOverviews());

describe("overview store", () => {
  it("keeps the last data up while a reload runs, then replaces it", async () => {
    await loadOverview("mcp|a", async () => ok("first"));
    const pending = deferred();
    const done = loadOverview("mcp|a", () => pending.promise);
    expect(readOverview("mcp|a")).toMatchObject({ data: "first" });
    expect(readOverview("mcp|a").request).not.toBeNull();

    pending.resolve(ok("second"));
    await done;
    expect(readOverview("mcp|a")).toMatchObject({ data: "second", error: null, request: null });
  });

  it("drops a response once a newer load for the key started", async () => {
    const older = deferred();
    const newer = deferred();
    const first = loadOverview("mcp|a", () => older.promise);
    const second = loadOverview("mcp|a", () => newer.promise);

    newer.resolve(ok("newer"));
    await second;
    older.resolve(ok("older"));
    await first;
    expect(readOverview("mcp|a").data).toBe("newer");
  });

  it("keeps the last data when a reload fails", async () => {
    await loadOverview("mcp|a", async () => ok("rows"));
    await loadOverview("mcp|a", async () => ({ ok: false, message: "offline" }));
    expect(readOverview("mcp|a")).toMatchObject({ data: "rows", error: "offline", request: null });
  });

  it("notifies only the listeners of the key that changed", async () => {
    let mcp = 0;
    let skills = 0;
    subscribeOverview("mcp|a", () => mcp++);
    const stop = subscribeOverview("skills|a", () => skills++);
    await loadOverview("mcp|a", async () => ok("rows"));
    expect(mcp).toBeGreaterThan(0);
    expect(skills).toBe(0);

    stop();
    await loadOverview("skills|a", async () => ok("rows"));
    expect(skills).toBe(0);
  });

  it("drops the oldest unwatched entries past the cap, never a watched one", async () => {
    subscribeOverview("watched", () => {});
    await loadOverview("watched", async () => ok("kept"));
    for (let index = 0; index < 40; index++) {
      await loadOverview(`scope|${index}`, async () => ok(index));
    }
    expect(readOverview("watched").data).toBe("kept");
    expect(readOverview("scope|0").loadedAt).toBeNull();
    expect(readOverview("scope|39").data).toBe(39);
  });

  it("drops a response whose entry was evicted meanwhile", async () => {
    const pending = deferred();
    const done = loadOverview("old", () => pending.promise);
    for (let index = 0; index < 40; index++) {
      await loadOverview(`scope|${index}`, async () => ok(index));
    }
    pending.resolve(ok("late"));
    await done;
    expect(readOverview("old").loadedAt).toBeNull();
  });
});
