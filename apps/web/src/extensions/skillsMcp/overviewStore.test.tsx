import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type { ExtensionCallOutcome } from "../client";
import {
  loadOverview,
  type OverviewState,
  readOverview,
  resetOverviews,
  subscribeOverview,
  useOverviewLoader,
} from "./overviewStore";

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

  it("waits for a load to settle before dropping entries, so loaders about to subscribe keep theirs", async () => {
    for (let index = 0; index < 16; index++) {
      await loadOverview(`scope|${index}`, async () => ok(index));
    }
    const pending = deferred();
    const done = loadOverview("new", () => pending.promise);
    expect(readOverview("scope|0").data).toBe(0);

    pending.resolve(ok("new"));
    await done;
    expect(readOverview("scope|0").loadedAt).toBeNull();
    expect(readOverview("new").data).toBe("new");
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

describe("useOverviewLoader", () => {
  let renderer: ReactTestRenderer | null = null;
  let renders: OverviewState<unknown>[] = [];

  function Probe(props: { active: boolean; fetch: (refresh: boolean) => Promise<Outcome> }) {
    renders.push(useOverviewLoader({ name: "test", key: "a", ...props }));
    return null;
  }

  async function mount(active: boolean, fetch: (refresh: boolean) => Promise<Outcome>) {
    renders = [];
    await act(() => {
      renderer = create(<Probe active={active} fetch={fetch} />);
    });
  }

  async function unmount() {
    await act(() => renderer?.unmount());
    renderer = null;
  }

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(1_000);
  });

  afterEach(async () => {
    await unmount();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("shows a reopened panel's stored result on its first render, and still fetches once", async () => {
    await mount(true, async () => ok("first"));
    await unmount();

    const pending = deferred();
    const fetch = vi.fn(() => pending.promise);
    await mount(true, fetch);
    expect(renders[0]).toMatchObject({ data: "first", error: null });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(renders.at(-1)).toMatchObject({ data: "first", loading: true });

    await act(async () => pending.resolve(ok("second")));
    expect(renders.at(-1)).toMatchObject({ data: "second", loading: false });
  });

  it("ignores reloads from a loader that has unmounted", async () => {
    const fetch = vi.fn(async () => ok("rows"));
    await mount(true, fetch);
    const late = renders.at(-1)!;
    await unmount();

    await late.reload();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(readOverview("test|a").data).toBe("rows");
  });

  it("hides an error stored before the mount until its own load settles", async () => {
    await mount(true, async () => ({ ok: false, message: "offline" }));
    expect(renders.at(-1)?.error).toBe("offline");
    await unmount();

    vi.setSystemTime(2_000);
    const pending = deferred();
    await mount(true, () => pending.promise);
    expect(renders.every((state) => state.error === null)).toBe(true);
    expect(renders.at(-1)?.loading).toBe(true);

    vi.setSystemTime(3_000);
    await act(async () => pending.resolve({ ok: false, message: "still offline" }));
    expect(renders.at(-1)).toMatchObject({ error: "still offline", loading: false });
  });

  it("shows nothing stored until the loader has been active in this mount", async () => {
    await mount(true, async () => ok("rows"));
    await unmount();

    const fetch = vi.fn(async () => ok("fresh"));
    await mount(false, fetch);
    expect(renders.at(-1)).toMatchObject({ data: null, loading: false });
    expect(fetch).not.toHaveBeenCalled();

    await act(() => renderer?.update(<Probe active fetch={fetch} />));
    expect(renders.some((state) => state.data === "rows")).toBe(true);
    expect(renders.at(-1)?.data).toBe("fresh");
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
