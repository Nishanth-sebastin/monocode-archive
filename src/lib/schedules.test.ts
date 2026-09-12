// @vitest-environment happy-dom
import { beforeEach, expect, it } from "vitest";
import { emitAttention, emittedAttention } from "./attention";
import {
  loadSchedules,
  nextOccurrence,
  removeSchedule,
  saveSchedule,
  setScheduleEnabled,
  skippedSlots,
  updateSchedule,
  MAX_SCHEDULE_HISTORY,
  type ScheduleCadence,
} from "./schedules";

const at = (y: number, m: number, d: number, h: number, min = 0) =>
  new Date(y, m - 1, d, h, min).getTime();

const draft = (over: Record<string, unknown> = {}) => ({
  name: "Standup prep",
  instructions: "Summarize open PRs.",
  cadence: { kind: "daily", time: "09:00" } as ScheduleCadence,
  mode: "notify" as const,
  target: { cwd: "/repo", harness: "claude" as const, model: "" },
  ...over,
});

beforeEach(() => localStorage.clear());

it("once fires at the set time and never again", () => {
  const future = Date.now() + 3600_000;
  expect(nextOccurrence({ kind: "once", at: future }, Date.now())).toBe(future);
  expect(nextOccurrence({ kind: "once", at: Date.now() - 1 }, Date.now())).toBeNull();
});

it("daily picks today before the time, tomorrow after it", () => {
  // Construct against a fixed local day to stay timezone-independent.
  const day = new Date(2024, 5, 10); // Jun 10 2024, local
  const before = new Date(day).setHours(8, 0, 0, 0);
  const nine = new Date(day).setHours(9, 0, 0, 0);
  const after = new Date(day).setHours(10, 0, 0, 0);
  const cadence: ScheduleCadence = { kind: "daily", time: "09:00" };
  expect(nextOccurrence(cadence, before)).toBe(nine);
  // Exactly at 09:00 counts as due — the next slot is tomorrow.
  expect(nextOccurrence(cadence, nine)).toBe(
    new Date(2024, 5, 11, 9, 0, 0, 0).getTime(),
  );
  expect(nextOccurrence(cadence, after)).toBe(
    new Date(2024, 5, 11, 9, 0, 0, 0).getTime(),
  );
});

it("weekly lands on the next matching weekday, local time", () => {
  // Jun 10 2024 is a Monday.
  const mondayMorning = at(2024, 6, 10, 8);
  const cadence: ScheduleCadence = { kind: "weekly", time: "09:00", weekday: 3 };
  // Wednesday of the same week.
  expect(nextOccurrence(cadence, mondayMorning)).toBe(at(2024, 6, 12, 9));
  // After Wednesday 09:00 → next week.
  expect(nextOccurrence(cadence, at(2024, 6, 12, 10))).toBe(at(2024, 6, 19, 9));
});

it("daily across a DST boundary still fires at 09:00 local", () => {
  // US DST spring forward was Mar 10 2024 — a daily 09:00 must not drift.
  const cadence: ScheduleCadence = { kind: "daily", time: "09:00" };
  const before = at(2024, 3, 9, 10); // Sat Mar 9, 10:00
  const next = nextOccurrence(cadence, before);
  expect(new Date(next!).getHours()).toBe(9);
  expect(new Date(next!).getDate()).toBe(10);
});

it("skippedSlots counts missed slots, bounded", () => {
  const cadence: ScheduleCadence = { kind: "daily", time: "09:00" };
  const monday = at(2024, 6, 10, 9);
  const thursday = at(2024, 6, 13, 10);
  // Tue, Wed, Thu 09:00 all passed while closed.
  expect(skippedSlots(cadence, monday, thursday)).toBe(3);
  expect(skippedSlots({ kind: "once", at: monday }, monday, thursday)).toBe(0);
});

it("save validates name, instructions, and a future once time", () => {
  expect(saveSchedule(draft({ name: " " })).error).toMatch(/name/i);
  expect(saveSchedule(draft({ instructions: " " })).error).toMatch(/instructions/i);
  expect(
    saveSchedule(
      draft({ cadence: { kind: "once", at: Date.now() - 1000 } }),
    ).error,
  ).toMatch(/future/i);
  expect(
    saveSchedule(draft({ target: { cwd: " ", harness: "claude", model: "" } }))
      .error,
  ).toMatch(/checkout/i);
});

it("saving arms nextRunAt from now; editing cadence re-arms", () => {
  const { schedule } = saveSchedule(draft());
  expect(schedule!.nextRunAt).toBeGreaterThan(Date.now());
  // Same cadence → keeps the armed time.
  const kept = saveSchedule(
    draft({ name: "Renamed" }),
    schedule!.id,
  ).schedule!;
  expect(kept.nextRunAt).toBe(schedule!.nextRunAt);
  // New cadence → re-armed.
  const moved = saveSchedule(
    draft({ cadence: { kind: "daily", time: "18:00" } }),
    schedule!.id,
  ).schedule!;
  expect(moved.nextRunAt).not.toBe(schedule!.nextRunAt);
  expect(moved.nextRunAt).toBeGreaterThan(Date.now());
});

it("pause keeps the schedule; resume re-arms rather than firing a stale slot", () => {
  const { schedule } = saveSchedule(draft());
  updateSchedule(schedule!.id, (row) => ({
    ...row,
    nextRunAt: Date.now() - 86_400_000, // overdue
  }));
  setScheduleEnabled(schedule!.id, false);
  expect(loadSchedules()[0].enabled).toBe(false);
  setScheduleEnabled(schedule!.id, true);
  const resumed = loadSchedules()[0];
  expect(resumed.nextRunAt).toBeGreaterThan(Date.now());
});

it("resuming a one-shot whose slot passed while paused marks it missed", () => {
  const { schedule } = saveSchedule(
    draft({ cadence: { kind: "once", at: Date.now() + 60_000 } }),
  );
  // The slot passed while paused — resuming must not fire stale
  // instructions; the schedule is marked missed and left unscheduled.
  updateSchedule(schedule!.id, (row) => ({
    ...row,
    cadence: { kind: "once", at: Date.now() - 60_000 },
    nextRunAt: Date.now() - 60_000,
  }));
  setScheduleEnabled(schedule!.id, false);
  setScheduleEnabled(schedule!.id, true);
  const resumed = loadSchedules()[0];
  expect(resumed.enabled).toBe(true);
  expect(resumed.nextRunAt).toBe(0);
  expect(resumed.history.at(-1)?.kind).toBe("missed");
  expect(resumed.lastOutcome).toMatch(/paused past/);
});

it("editing a spent one-shot requires a fresh time — not a silent dead row", () => {
  const past = Date.now() - 60_000;
  const { schedule } = saveSchedule(
    draft({ cadence: { kind: "once", at: Date.now() + 60_000 } }),
  );
  // The one-shot fired and is spent.
  updateSchedule(schedule!.id, (row) => ({
    ...row,
    cadence: { kind: "once", at: past },
    nextRunAt: 0,
  }));
  const edited = saveSchedule(
    draft({ name: "Renamed", cadence: { kind: "once", at: past } }),
    schedule!.id,
  );
  expect(edited.error).toMatch(/future/i);
  // Re-pointing it to the future revives it.
  const revived = saveSchedule(
    draft({ cadence: { kind: "once", at: Date.now() + 3600_000 } }),
    schedule!.id,
  );
  expect(revived.schedule?.nextRunAt).toBeGreaterThan(Date.now());
});

it("removing a schedule resolves its emitted rows", () => {
  const { schedule } = saveSchedule(draft());
  emitAttention({
    key: `schedule-due:${schedule!.id}`,
    kind: "schedule",
    title: "Standup prep",
    urgency: 2,
    at: Date.now(),
    signature: "due:1",
    source: { kind: "schedule", id: schedule!.id },
  });
  emitAttention({
    key: "watcher:other:x",
    kind: "watcher",
    title: "unrelated",
    urgency: 2,
    at: Date.now(),
    signature: "x",
    source: { kind: "watcher", id: "other" },
  });
  removeSchedule(schedule!.id);
  expect(emittedAttention().map((row) => row.key)).toEqual([
    "watcher:other:x",
  ]);
});

it("malformed schedules are dropped; history is bounded", () => {
  localStorage.setItem(
    "monocode.schedules.v1",
    JSON.stringify([
      { id: "", name: "" },
      {
        id: "s1",
        name: "ok",
        instructions: "do it",
        cadence: { kind: "daily", time: "09:00" },
        target: { cwd: "/repo", harness: "claude" },
        history: Array.from({ length: 40 }, (_, i) => ({
          at: i + 1,
          kind: "run",
          text: `run ${i}`,
        })),
      },
    ]),
  );
  const schedules = loadSchedules();
  expect(schedules).toHaveLength(1);
  expect(schedules[0].history.length).toBe(MAX_SCHEDULE_HISTORY);
  expect(schedules[0].mode).toBe("notify");
});
