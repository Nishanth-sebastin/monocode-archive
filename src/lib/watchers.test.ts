// @vitest-environment happy-dom
import { beforeEach, expect, it } from "vitest";
import { emitAttention, emittedAttention } from "./attention";
import {
  loadWatchers,
  removeWatcher,
  saveWatcher,
  setWatcherEnabled,
  updateWatcher,
  watcherPollKey,
  MAX_WATCHER_SEEN,
  type Watcher,
  type WatcherSource,
} from "./watchers";

const JIRA_SOURCE: WatcherSource = {
  kind: "jira-items",
  site: "https://acme.atlassian.net",
  filter: { project: "ENG", filter: "", assigned: true },
};

const draft = (over: Record<string, unknown> = {}) => ({
  name: "Jira · ENG",
  source: JIRA_SOURCE,
  enabled: true,
  mode: "notify" as const,
  intervalSec: 300,
  cooldownSec: 900,
  ...over,
});

beforeEach(() => localStorage.clear());

it("saves a watcher with cursor state initialized for a first poll", () => {
  const { watcher, error } = saveWatcher(draft());
  expect(error).toBeUndefined();
  expect(watcher).toBeDefined();
  expect(watcher!.seen).toEqual([]);
  expect(watcher!.nextPollAt).toBe(0);
  expect(watcher!.failures).toBe(0);
  expect(loadWatchers()).toHaveLength(1);
});

it("requires an action for draft/run modes and a checkout for run", () => {
  expect(saveWatcher(draft({ mode: "draft" })).error).toMatch(/action/i);
  expect(
    saveWatcher(draft({ mode: "run", actionId: "implement" })).error,
  ).toMatch(/checkout/i);
  expect(
    saveWatcher(
      draft({
        mode: "run",
        actionId: "implement",
        target: { cwd: "/repo", harness: "claude", model: "" },
      }),
    ).error,
  ).toBeUndefined();
});

it("rejects empty names and invalid sources", () => {
  expect(saveWatcher(draft({ name: "  " })).error).toMatch(/name/i);
  expect(
    saveWatcher(draft({ source: { kind: "nope" } })).error,
  ).toMatch(/source/i);
});

it("editing a watcher keeps the cursor when the source is unchanged, resets it when re-pointed", () => {
  const { watcher } = saveWatcher(draft());
  updateWatcher(watcher!.id, (row) => ({
    ...row,
    cursor: "2024-01-01T00:00:00Z",
    seen: ["a", "b"],
  }));
  const renamed = saveWatcher(
    draft({ name: "Renamed", cursor: "2024-01-01T00:00:00Z" }),
    watcher!.id,
  ).watcher!;
  expect(renamed.cursor).toBe("2024-01-01T00:00:00Z");
  expect(renamed.seen).toEqual(["a", "b"]);
  const repointed = saveWatcher(
    draft({
      source: { ...JIRA_SOURCE, filter: { ...JIRA_SOURCE.filter, project: "OPS" } },
    }),
    watcher!.id,
  ).watcher!;
  expect(repointed.cursor).toBeUndefined();
  expect(repointed.seen).toEqual([]);
});

it("removing a watcher clears its emitted rows — nothing can resolve them later", () => {
  const { watcher } = saveWatcher(draft());
  const other = saveWatcher(draft({ name: "Other" })).watcher!;
  for (const id of [watcher!.id, other.id]) {
    emitAttention({
      key: `watcher:${id}:cond`,
      kind: "ticket",
      title: `Row ${id}`,
      urgency: 1,
      at: Date.now(),
      signature: "sig",
      source: { kind: "watcher", id },
    });
  }
  removeWatcher(watcher!.id);
  expect(emittedAttention().map((row) => row.key)).toEqual([
    `watcher:${other.id}:cond`,
  ]);
});

it("re-pointing a watcher clears rows bound to the old source", () => {
  const { watcher } = saveWatcher(draft());
  emitAttention({
    key: `watcher:${watcher!.id}:old`,
    kind: "ticket",
    title: "Old row",
    urgency: 1,
    at: Date.now(),
    signature: "sig",
    source: { kind: "watcher", id: watcher!.id },
  });
  saveWatcher(
    draft({
      source: { ...JIRA_SOURCE, filter: { ...JIRA_SOURCE.filter, project: "OPS" } },
    }),
    watcher!.id,
  );
  expect(emittedAttention()).toEqual([]);
});

it("pause clears backoff and resume polls promptly", () => {
  const { watcher } = saveWatcher(draft());
  updateWatcher(watcher!.id, (row) => ({
    ...row,
    failures: 4,
    nextPollAt: Date.now() + 600_000,
  }));
  setWatcherEnabled(watcher!.id, false);
  expect(loadWatchers()[0].enabled).toBe(false);
  setWatcherEnabled(watcher!.id, true);
  const resumed = loadWatchers()[0];
  expect(resumed.failures).toBe(0);
  expect(resumed.nextPollAt).toBe(0);
});

it("updateWatcher bounds the seen ring and history", () => {
  const { watcher } = saveWatcher(draft());
  updateWatcher(watcher!.id, (row) => ({
    ...row,
    seen: Array.from({ length: MAX_WATCHER_SEEN + 50 }, (_, i) => `k${i}`),
    history: Array.from({ length: 40 }, (_, i) => ({
      at: i,
      kind: "event" as const,
      text: `event ${i}`,
    })),
  }));
  const saved = loadWatchers()[0];
  expect(saved.seen.length).toBe(MAX_WATCHER_SEEN);
  expect(saved.seen[0]).toBe("k50"); // oldest evicted
  expect(saved.history.length).toBe(20);
});

it("malformed persisted watchers are dropped", () => {
  localStorage.setItem(
    "monocode.watchers.v1",
    JSON.stringify([
      { id: "", name: "", source: null },
      {
        id: "w1",
        name: "ok",
        source: JIRA_SOURCE,
        intervalSec: 1, // below the floor — clamped
        seen: "not-an-array",
      },
    ]),
  );
  const watchers = loadWatchers();
  expect(watchers).toHaveLength(1);
  expect(watchers[0].intervalSec).toBe(60);
  expect(watchers[0].seen).toEqual([]);
});

it("poll key shares fetches only across identical bindings", () => {
  const base: Watcher = saveWatcher(draft()).watcher!;
  const same = saveWatcher(draft({ name: "Second" })).watcher!;
  expect(watcherPollKey(base)).toBe(watcherPollKey(same));
  const prSource: WatcherSource = {
    kind: "github-pr",
    cwd: "/repo",
    repo: "acme/app",
    number: 4,
  };
  const a = saveWatcher(draft({ source: prSource })).watcher!;
  const b = saveWatcher(
    draft({ source: { ...prSource, sessionId: "s1" } }),
  ).watcher!;
  expect(watcherPollKey(a)).not.toBe(watcherPollKey(b));
});
