import { describe, expect, it, vi } from "vitest";
import { createCreatedTimesLoader, createdByPath } from "../createdTimes";

/** A fetch whose reads resolve only when the test says so. */
function controlledFetch() {
  const pending: Array<(v: Map<string, number>) => void> = [];
  const fetch = vi.fn(
    () => new Promise<Map<string, number>>((resolve) => pending.push(resolve)),
  );
  return { fetch, resolveNext: (v = new Map<string, number>()) => pending.shift()!(v) };
}

describe("createCreatedTimesLoader", () => {
  // The whole point of the gate: a vault that never sorts by created never
  // pays for the vault-wide read.
  it("does not read at all when no active sort is a Created mode", async () => {
    const fetch = vi.fn(async () => new Map<string, number>());
    const loader = createCreatedTimesLoader(fetch);
    await expect(loader.load("recent", {})).resolves.toBeNull();
    await expect(
      loader.load("name", { Work: "modified-asc", Home: "name-desc" }),
    ).resolves.toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("reads when the default is a Created mode", async () => {
    const times = new Map([["a.md", 1]]);
    const fetch = vi.fn(async () => times);
    const loader = createCreatedTimesLoader(fetch);
    await expect(loader.load("created-asc", {})).resolves.toBe(times);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("reads when only one folder override is a Created mode", async () => {
    const fetch = vi.fn(async () => new Map<string, number>());
    const loader = createCreatedTimesLoader(fetch);
    await loader.load("name", { "Work/Sub": "created-desc" });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("coalesces a burst into the running read plus ONE follow-up", async () => {
    const { fetch, resolveNext } = controlledFetch();
    const loader = createCreatedTimesLoader(fetch);
    const first = loader.load("created-desc", {});
    const burst = [1, 2, 3].map(() => loader.load("created-desc", {}));
    expect(fetch).toHaveBeenCalledTimes(1);

    const one = new Map([["a.md", 1]]);
    resolveNext(one);
    await expect(first).resolves.toBe(one);
    // The follow-up starts only after the first settles, so it cannot miss a
    // change that prompted the burst.
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    const two = new Map([["a.md", 2]]);
    resolveNext(two);
    for (const p of burst) await expect(p).resolves.toBe(two);
    expect(fetch).toHaveBeenCalledTimes(2);

    // Idle again: the next call reads afresh.
    const next = loader.load("created-desc", {});
    expect(fetch).toHaveBeenCalledTimes(3);
    resolveNext();
    await next;
  });

  it("a failed read rejects its callers but does not wedge the loader", async () => {
    let fail = true;
    const fetch = vi.fn(async () => {
      if (fail) throw new Error("index busy");
      return new Map([["a.md", 1]]);
    });
    const loader = createCreatedTimesLoader(fetch);
    await expect(loader.load("created-asc", {})).rejects.toThrow("index busy");
    fail = false;
    await expect(loader.load("created-asc", {})).resolves.toEqual(new Map([["a.md", 1]]));
  });
});

describe("createdByPath", () => {
  it("keeps dated notes and drops undated ones (they sort as unknown)", () => {
    const byPath = new Map([
      ["a.md", { created: 10 }],
      ["b.md", { created: null }],
      ["c.md", { created: 0 }],
    ]);
    expect(createdByPath(byPath)).toEqual(
      new Map([
        ["a.md", 10],
        ["c.md", 0],
      ]),
    );
  });
});
