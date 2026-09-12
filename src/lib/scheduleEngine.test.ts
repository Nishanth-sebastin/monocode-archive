// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { emittedAttention } from "./attention";
import {
  loadSchedules,
  saveSchedule,
  updateSchedule,
  CATCH_UP_MAX_MS,
  type ScheduleCadence,
  type ScheduleDraft,
} from "./schedules";
import {
  runScheduleNow,
  startScheduleEngine,
  stopScheduleEngine,
} from "./scheduleEngine";

let stopEngine: (() => void) | undefined;
const start = (hooks: Parameters<typeof startScheduleEngine>[0] = {}) => {
  stopEngine = startScheduleEngine(hooks);
};

const draft = (over: Partial<ScheduleDraft> = {}): ScheduleDraft => ({
  name: "Standup prep",
  instructions: "Summarize open PRs.",
  cadence: { kind: "daily", time: "09:00" },
  mode: "notify",
  target: { cwd: "/repo", harness: "claude", model: "" },
  ...over,
});

function makeSchedule(over: Partial<ScheduleDraft> = {}) {
  const created = saveSchedule(draft(over));
  if (!created.schedule) throw new Error(created.error);
  return created.schedule;
}

/** Move a schedule's fire time into the past so the next tick picks it up. */
const makeDue = (id: string, overdueBy = 1000) =>
  updateSchedule(id, (row) => ({ ...row, nextRunAt: Date.now() - overdueBy }));

beforeEach(() => localStorage.clear());
afterEach(() => {
  stopEngine?.();
  stopEngine = undefined;
  stopScheduleEngine();
});

it("fires a due schedule once, emits an outcome row, and re-arms", async () => {
  const schedule = makeSchedule({ mode: "run" });
  const runSchedule = vi.fn().mockResolvedValue(undefined);
  makeDue(schedule.id);
  start({ runSchedule });
  await vi.waitFor(() => expect(runSchedule).toHaveBeenCalledTimes(1));
  const saved = loadSchedules()[0];
  // Daily cadence re-arms to tomorrow — the row persists as an outcome.
  expect(saved.nextRunAt).toBeGreaterThan(Date.now());
  expect(saved.lastRunAt).toBeDefined();
  expect(saved.history.at(-1)?.kind).toBe("run");
  expect(emittedAttention().some((row) => row.kind === "schedule")).toBe(true);
});

it("a spent one-shot goes quiet after firing", async () => {
  const schedule = makeSchedule({
    cadence: { kind: "once", at: Date.now() + 60_000 },
    mode: "run",
  });
  const runSchedule = vi.fn().mockResolvedValue(undefined);
  // The slot arrived and passed while the app was closed — inside the
  // catch-up window, so it fires once and then goes quiet.
  updateSchedule(schedule.id, (row) => ({
    ...row,
    cadence: { kind: "once", at: Date.now() - 1000 },
    nextRunAt: Date.now() - 1000,
  }));
  start({ runSchedule });
  await vi.waitFor(() => expect(runSchedule).toHaveBeenCalledTimes(1));
  const saved = loadSchedules()[0];
  expect(saved.nextRunAt).toBe(0); // spent — never fires again
});

it("never fires a disabled schedule", async () => {
  makeSchedule({ enabled: false, mode: "run" });
  const runSchedule = vi.fn().mockResolvedValue(undefined);
  makeDue(loadSchedules()[0].id);
  start({ runSchedule });
  await new Promise((resolve) => setTimeout(resolve, 30));
  expect(runSchedule).not.toHaveBeenCalled();
});

it("catch-up runs once and records skipped slots — no burst", async () => {
  const schedule = makeSchedule({ mode: "run" });
  const runSchedule = vi.fn().mockResolvedValue(undefined);
  // Pretend the app was closed for three days of daily slots.
  updateSchedule(schedule.id, (row) => ({
    ...row,
    nextRunAt: Date.now() - 3 * 86_400_000,
  }));
  start({ runSchedule });
  await vi.waitFor(() => expect(runSchedule).toHaveBeenCalledTimes(1));
  const saved = loadSchedules()[0];
  expect(runSchedule).toHaveBeenCalledTimes(1);
  expect(
    saved.history.some(
      (entry) => entry.kind === "missed" && /skipped \d+/.test(entry.text),
    ),
  ).toBe(true);
  expect(saved.nextRunAt).toBeGreaterThan(Date.now());
});

it("a one-shot overdue beyond the catch-up window is marked missed, not run", async () => {
  const schedule = makeSchedule({
    cadence: { kind: "once", at: Date.now() + 60_000 },
    mode: "run",
  });
  const runSchedule = vi.fn().mockResolvedValue(undefined);
  updateSchedule(schedule.id, (row) => ({
    ...row,
    cadence: { kind: "once", at: Date.now() - CATCH_UP_MAX_MS - 1000 },
    nextRunAt: Date.now() - CATCH_UP_MAX_MS - 1000,
  }));
  start({ runSchedule });
  await vi.waitFor(() =>
    expect(loadSchedules()[0].history.at(-1)?.kind).toBe("missed"),
  );
  expect(runSchedule).not.toHaveBeenCalled();
  const row = emittedAttention().find(
    (item) => item.key === `schedule-outcome:${schedule.id}`,
  );
  expect(row?.detail).toMatch(/Missed/);
});

it("a busy bound conversation skips the run and records it", async () => {
  const schedule = makeSchedule({
    mode: "run",
    target: { cwd: "/repo", harness: "claude", model: "", sessionId: "s1" },
  });
  const runSchedule = vi.fn().mockResolvedValue(undefined);
  makeDue(schedule.id);
  start({ runSchedule, targetBusy: () => true });
  await vi.waitFor(() =>
    expect(loadSchedules()[0].history.at(-1)?.kind).toBe("skip"),
  );
  expect(runSchedule).not.toHaveBeenCalled();
  // Re-armed — a busy agent doesn't kill the schedule.
  expect(loadSchedules()[0].nextRunAt).toBeGreaterThan(Date.now());
});

it("notify mode emits the row without dispatching", async () => {
  const schedule = makeSchedule({ mode: "notify" });
  const runSchedule = vi.fn();
  const prepareDraft = vi.fn();
  makeDue(schedule.id);
  start({ runSchedule, prepareDraft });
  await vi.waitFor(() =>
    expect(
      emittedAttention().some(
        (row) => row.key === `schedule-due:${schedule.id}`,
      ),
    ).toBe(true),
  );
  expect(runSchedule).not.toHaveBeenCalled();
  expect(prepareDraft).not.toHaveBeenCalled();
  expect(loadSchedules()[0].history.at(-1)?.text).toBe("Notified.");
});

it("runScheduleNow fires immediately without catch-up bookkeeping", async () => {
  const schedule = makeSchedule({ mode: "run" });
  const runSchedule = vi.fn().mockResolvedValue(undefined);
  start({ runSchedule });
  runScheduleNow(schedule.id);
  await vi.waitFor(() => expect(runSchedule).toHaveBeenCalledTimes(1));
  const saved = loadSchedules()[0];
  // No "skipped N slots" entry for a manual run.
  expect(saved.history.every((entry) => entry.kind !== "missed")).toBe(true);
  // And the regular cadence is still armed for later.
  expect(saved.nextRunAt).toBeGreaterThan(Date.now());
});

it("a failed run records the error and still re-arms", async () => {
  const schedule = makeSchedule({ mode: "run" });
  const runSchedule = vi.fn().mockResolvedValue("The bound agent is gone.");
  makeDue(schedule.id);
  start({ runSchedule });
  await vi.waitFor(() =>
    expect(loadSchedules()[0].history.at(-1)?.kind).toBe("error"),
  );
  const saved = loadSchedules()[0];
  expect(saved.lastOutcome).toBe("The bound agent is gone.");
  expect(saved.nextRunAt).toBeGreaterThan(Date.now());
});
