// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  emittedAttention,
  emittedAttention as rows,
} from "./attention";
import {
  loadWatchers,
  saveWatcher,
  setWatcherEnabled,
  updateWatcher,
} from "./watchers";
import type { WatcherPoll } from "./watcherPoll";
import {
  pollWatcherNow,
  startWatcherEngine,
  stopWatcherEngine,
} from "./watcherEngine";

const { poll } = vi.hoisted(() => ({ poll: vi.fn() }));
vi.mock("./watcherPoll", () => ({
  pollWatcherSource: poll,
}));

const JIRA = {
  kind: "jira-items" as const,
  site: "https://acme.atlassian.net",
  filter: { project: "ENG", filter: "", assigned: true },
};

const condition = (key: string, signature = `${key}:sig`) => ({
  key,
  signature,
  item: {
    kind: "ticket" as const,
    title: `Event ${key}`,
    urgency: 1 as const,
    at: Date.now(),
  },
});

const result = (...keys: string[]): WatcherPoll => ({
  conditions: keys.map((key) => condition(key)),
});

function makeWatcher(over: Record<string, unknown> = {}) {
  const created = saveWatcher({
    name: "Jira watch",
    source: JIRA,
    enabled: true,
    mode: "notify",
    intervalSec: 300,
    cooldownSec: 900,
    ...over,
  });
  if (!created.watcher) throw new Error(created.error);
  return created.watcher;
}

let stopEngine: (() => void) | undefined;
const start = (hooks: Parameters<typeof startWatcherEngine>[0] = {}) => {
  stopEngine = startWatcherEngine(hooks);
};

beforeEach(() => {
  localStorage.clear();
  poll.mockReset();
});
afterEach(() => {
  // The returned cleanup removes the WATCHERS_CHANGED listener —
  // stopWatcherEngine alone leaves it firing ticks into later tests.
  stopEngine?.();
  stopEngine = undefined;
  stopWatcherEngine();
});

it("polls a due watcher, emits rows, and records the seen keys", async () => {
  makeWatcher();
  poll.mockResolvedValue(result("a", "b"));
  start();
  await vi.waitFor(() => expect(rows().length).toBe(2));
  const watcher = loadWatchers()[0];
  expect(watcher.seen).toEqual(["a", "b"]);
  expect(watcher.failures).toBe(0);
  expect(watcher.nextPollAt).toBeGreaterThan(Date.now());
  expect(watcher.lastEventAt).toBeDefined();
});

it("never polls a disabled watcher", async () => {
  makeWatcher({ enabled: false });
  start();
  await new Promise((resolve) => setTimeout(resolve, 30));
  expect(poll).not.toHaveBeenCalled();
});

it("dedupes replayed conditions — a second identical poll emits nothing new", async () => {
  const watcher = makeWatcher();
  poll.mockResolvedValue(result("a"));
  start();
  await vi.waitFor(() => expect(rows().length).toBe(1));
  const firstAt = emittedAttention()[0].at;
  pollWatcherNow(watcher.id);
  // Waiting on the applied streak also guarantees the second poll landed —
  // the poll mock resolves before its result is written back.
  await vi.waitFor(() => expect(loadWatchers()[0].idleStreak).toBe(1));
  expect(poll).toHaveBeenCalledTimes(2);
  expect(rows().length).toBe(1);
  expect(emittedAttention()[0].at).toBe(firstAt);
});

it("resolves rows for conditions that disappeared from the poll", async () => {
  const watcher = makeWatcher();
  poll.mockResolvedValue(result("a", "b"));
  start();
  await vi.waitFor(() => expect(rows().length).toBe(2));
  poll.mockResolvedValue(result("a"));
  pollWatcherNow(watcher.id);
  await vi.waitFor(() => expect(rows().length).toBe(1));
  expect(rows()[0].key).toBe(`watcher:${watcher.id}:a`);
  // The cleared condition is un-seen — a re-trigger counts as new.
  expect(loadWatchers()[0].seen).toEqual(["a"]);
});

it("backs off and surfaces a lifecycle row after a failed poll", async () => {
  const watcher = makeWatcher();
  poll.mockRejectedValue(new Error("connection refused"));
  start();
  await vi.waitFor(() => {
    expect(loadWatchers()[0].failures).toBe(1);
  });
  const saved = loadWatchers()[0];
  expect(saved.lastError).toMatch(/connection refused/);
  expect(saved.nextPollAt).toBeGreaterThan(Date.now() + 30_000);
  const errorRow = rows().find((row) => row.key === `watcher-error:${watcher.id}`);
  expect(errorRow?.kind).toBe("watcher");
  expect(errorRow?.action?.kind).toBe("open-automations");
});

it("clears the error row when the watcher recovers", async () => {
  const watcher = makeWatcher();
  poll.mockRejectedValueOnce(new Error("offline"));
  poll.mockResolvedValue(result("a"));
  start();
  await vi.waitFor(() =>
    expect(rows().some((row) => row.key === `watcher-error:${watcher.id}`)).toBe(true),
  );
  pollWatcherNow(watcher.id);
  await vi.waitFor(() =>
    expect(rows().some((row) => row.key === `watcher-error:${watcher.id}`)).toBe(false),
  );
  expect(rows().map((row) => row.key)).toEqual([`watcher:${watcher.id}:a`]);
});

it("cooldown applies within a single poll — N fresh events run once", async () => {
  const runAction = vi.fn().mockResolvedValue(undefined);
  makeWatcher({
    mode: "run",
    actionId: "implement",
    target: { cwd: "/repo", harness: "claude", model: "" },
  });
  poll.mockResolvedValue(result("a", "b", "c"));
  start({ runAction });
  await vi.waitFor(() => expect(rows().length).toBe(3));
  await vi.waitFor(() =>
    expect(
      loadWatchers()[0].history.filter(
        (entry) => entry.kind === "skip" && /Cooldown/.test(entry.text),
      ).length,
    ).toBe(2),
  );
  expect(runAction).toHaveBeenCalledTimes(1);
});

it("a moved signature re-dispatches — the condition changed, not replayed", async () => {
  const prepareDraft = vi.fn();
  const watcher = makeWatcher({ mode: "draft", actionId: "triage" });
  poll.mockResolvedValue({ conditions: [condition("a", "sig-1")] });
  start({ prepareDraft });
  await vi.waitFor(() => expect(prepareDraft).toHaveBeenCalledTimes(1));
  poll.mockResolvedValue({ conditions: [condition("a", "sig-2")] });
  pollWatcherNow(watcher.id);
  await vi.waitFor(() => expect(prepareDraft).toHaveBeenCalledTimes(2));
  // Same key — the row updated in place rather than duplicating.
  expect(rows().filter((row) => row.key === `watcher:${watcher.id}:a`).length).toBe(1);
  expect(rows()[0].signature).toBe("sig-2");
});

it("a poll result cannot resurrect a watcher paused mid-flight", async () => {
  const watcher = makeWatcher();
  let release: (value: WatcherPoll) => void = () => {};
  poll.mockImplementation(
    () => new Promise<WatcherPoll>((resolve) => (release = resolve)),
  );
  start();
  await vi.waitFor(() => expect(poll).toHaveBeenCalledTimes(1));
  setWatcherEnabled(watcher.id, false);
  release(result("a"));
  await vi.waitFor(() =>
    expect(loadWatchers()[0].seen).toContain("a"),
  );
  expect(loadWatchers()[0].enabled).toBe(false);
});

it("stretches the interval on consecutive idle polls", async () => {
  const watcher = makeWatcher();
  poll.mockResolvedValue(result("a"));
  start();
  // idleStreak starts at 0 — wait for the first poll to actually apply so
  // pollWatcherNow doesn't queue a flag mid-flight.
  await vi.waitFor(() =>
    expect(loadWatchers()[0].lastPollAt).toBeGreaterThan(0),
  );
  // The stretch factor is 1 + floor(idleStreak / 4), computed from the
  // pre-poll streak — the fifth idle poll is the first that stretches.
  for (let streak = 1; streak <= 5; streak += 1) {
    pollWatcherNow(watcher.id);
    await vi.waitFor(() =>
      expect(loadWatchers()[0].idleStreak).toBe(streak),
    );
  }
  const idle = loadWatchers()[0];
  expect(idle.nextPollAt - idle.lastPollAt!).toBeGreaterThan(
    idle.intervalSec * 1000,
  );
  expect(idle.nextPollAt - idle.lastPollAt!).toBeLessThanOrEqual(
    idle.intervalSec * 1000 * 4,
  );
});

it("run mode dispatches once per event and honors the cooldown", async () => {
  const runAction = vi.fn().mockResolvedValue(undefined);
  const watcher = makeWatcher({
    mode: "run",
    actionId: "implement",
    target: { cwd: "/repo", harness: "claude", model: "" },
  });
  poll.mockResolvedValue(result("a"));
  start({ runAction });
  await vi.waitFor(() => expect(runAction).toHaveBeenCalledTimes(1));
  // Second distinct event inside the cooldown — skipped, logged.
  poll.mockResolvedValue(result("a", "b"));
  pollWatcherNow(watcher.id);
  await vi.waitFor(() => expect(poll).toHaveBeenCalledTimes(2));
  await vi.waitFor(() =>
    expect(
      loadWatchers()[0].history.some(
        (entry) => entry.kind === "skip" && /Cooldown/.test(entry.text),
      ),
    ).toBe(true),
  );
  expect(runAction).toHaveBeenCalledTimes(1);
});

it("shared poll keys make one provider call for peer watchers", async () => {
  makeWatcher({ name: "One" });
  makeWatcher({ name: "Two" });
  poll.mockResolvedValue(result("a"));
  start();
  await vi.waitFor(() => expect(rows().length).toBe(2));
  expect(poll).toHaveBeenCalledTimes(1);
  expect(loadWatchers().every((watcher) => watcher.seen.includes("a"))).toBe(true);
});
