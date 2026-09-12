import {
  ATTENTION_INFO,
  emitAttention,
  type AttentionItem,
} from "./attention";
import {
  CATCH_UP_MAX_MS,
  SCHEDULES_CHANGED,
  loadSchedules,
  nextOccurrence,
  scheduleHistory,
  skippedSlots,
  updateSchedule,
  type Schedule,
} from "./schedules";

/**
 * The schedule runtime (#24). One interval for every schedule — no per-row
 * timers. Each tick runs only schedules whose `nextRunAt` has come due.
 *
 * Missed-run policy is deliberately small: a recurring schedule that fell
 * behind (app closed, machine asleep) runs ONCE for the latest slot and
 * records the skipped count — never a burst of back-runs, never a
 * duplicate. A one-shot overdue by more than `CATCH_UP_MAX_MS` is marked
 * missed rather than firing stale instructions on launch.
 *
 * The engine is foreground-only: it lives in the WebView and stops when
 * MonoCode closes. The UI states this plainly everywhere a schedule is
 * shown.
 */

export type ScheduleEngineHooks = {
  /** "Prepare draft" — open the review surface with the instructions. */
  prepareDraft?: (schedule: Schedule) => void;
  /** "Run" — dispatch the instructions into the bound target. Returns an
   * error string on refusal (busy agent, missing checkout). */
  runSchedule?: (schedule: Schedule) => Promise<string | void>;
  /** Is the bound conversation busy right now? Busy targets skip — runs
   * never queue silently. */
  targetBusy?: (schedule: Schedule) => boolean;
};

const TICK_MS = 15_000;
let timer: number | undefined;
const inflight = new Set<string>();
/** Manual "run now" — fires once without touching catch-up accounting. */
const queuedRuns = new Set<string>();

export function startScheduleEngine(hooks: ScheduleEngineHooks): () => void {
  stopScheduleEngine();
  const onChange = () => void tick(hooks);
  window.addEventListener(SCHEDULES_CHANGED, onChange);
  timer = window.setInterval(() => void tick(hooks), TICK_MS);
  void tick(hooks);
  return () => {
    window.removeEventListener(SCHEDULES_CHANGED, onChange);
    stopScheduleEngine();
  };
}

export function stopScheduleEngine() {
  if (timer !== undefined) window.clearInterval(timer);
  timer = undefined;
}

/** "Run now" from the Automations page — fires once regardless of cadence.
 * Uses 1, not 0: `nextRunAt` 0 means "unscheduled" and never fires. */
export function runScheduleNow(id: string) {
  queuedRuns.add(id);
  updateSchedule(id, (schedule) => ({ ...schedule, nextRunAt: 1 }));
}

/** One row per schedule — the latest outcome replaces the previous. The
 * signature carries the run time, so a new run resurfaces a muted row. */
function outcomeRow(
  schedule: Schedule,
  text: string,
  ok: boolean,
  runAt: number,
) {
  const item: AttentionItem = {
    key: `schedule-outcome:${schedule.id}`,
    kind: "schedule",
    title: `${schedule.name} — ${ok ? "ran" : "did not run"}`,
    detail: text,
    urgency: ATTENTION_INFO,
    at: runAt,
    signature: `outcome:${runAt}:${text.slice(0, 120)}`,
    cwd: schedule.target.cwd,
    sessionId: schedule.target.sessionId,
    source: { kind: "schedule", id: schedule.id },
    action: schedule.target.sessionId
      ? { kind: "open-session", sessionId: schedule.target.sessionId }
      : { kind: "open-automations" },
  };
  emitAttention(item);
}

/** "Notify" mode — the schedule row itself is the notification. */
function notifyRow(schedule: Schedule, runAt: number) {
  emitAttention({
    key: `schedule-due:${schedule.id}`,
    kind: "schedule",
    title: schedule.name,
    detail: schedule.instructions.split("\n")[0].slice(0, 160),
    urgency: ATTENTION_INFO,
    at: runAt,
    signature: `due:${runAt}`,
    cwd: schedule.target.cwd,
    sessionId: schedule.target.sessionId,
    source: { kind: "schedule", id: schedule.id },
    action: schedule.target.sessionId
      ? { kind: "open-session", sessionId: schedule.target.sessionId }
      : { kind: "open-automations" },
  });
}

async function fire(
  schedule: Schedule,
  hooks: ScheduleEngineHooks,
  now: number,
  manual: boolean,
): Promise<void> {
  const skipped = manual
    ? 0
    : skippedSlots(schedule.cadence, schedule.nextRunAt, now);
  const next = nextOccurrence(schedule.cadence, now);
  const rearm = { nextRunAt: next ?? 0 };

  // Overdue beyond the catch-up window → record a miss, re-arm, no run.
  const overdueBy = now - schedule.nextRunAt;
  if (
    !manual &&
    schedule.cadence.kind === "once" &&
    overdueBy > CATCH_UP_MAX_MS
  ) {
    updateSchedule(schedule.id, (row) => ({
      ...row,
      ...rearm,
      lastOutcome: "Missed — the app was closed past the catch-up window.",
      history: scheduleHistory(
        row,
        { kind: "missed", text: "Missed — over 24h overdue; not run." },
        now,
      ),
    }));
    outcomeRow(
      schedule,
      "Missed — the app was closed past the catch-up window.",
      false,
      now,
    );
    return;
  }

  // Busy bound conversations skip — a run never queues silently.
  if (hooks.targetBusy?.(schedule)) {
    updateSchedule(schedule.id, (row) => ({
      ...row,
      ...rearm,
      lastOutcome: "Skipped — the bound conversation is busy.",
      history: scheduleHistory(
        row,
        { kind: "skip", text: "Skipped — bound conversation busy." },
        now,
      ),
    }));
    outcomeRow(schedule, "Skipped — the bound conversation is busy.", false, now);
    return;
  }

  updateSchedule(schedule.id, (row) => ({
    ...row,
    ...rearm,
    lastRunAt: now,
    ...(skipped
      ? {
          history: scheduleHistory(
            row,
            {
              kind: "missed",
              text: `Caught up — skipped ${skipped} earlier slot${skipped === 1 ? "" : "s"}.`,
            },
            now,
          ),
        }
      : {}),
  }));

  try {
    let outcome: string;
    if (schedule.mode === "notify") {
      notifyRow(schedule, now);
      outcome = "Notified.";
    } else if (schedule.mode === "draft") {
      hooks.prepareDraft?.(schedule);
      outcome = "Draft prepared.";
    } else {
      const error = await hooks.runSchedule?.(schedule);
      if (error) {
        updateSchedule(schedule.id, (row) => ({
          ...row,
          lastOutcome: error,
          history: scheduleHistory(row, { kind: "error", text: error }),
        }));
        outcomeRow(schedule, error, false, now);
        return;
      }
      outcome = "Ran.";
    }
    updateSchedule(schedule.id, (row) => ({
      ...row,
      lastOutcome: outcome,
      history: scheduleHistory(row, { kind: "run", text: outcome }, now),
    }));
    outcomeRow(schedule, outcome, true, now);
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error);
    updateSchedule(schedule.id, (row) => ({
      ...row,
      lastOutcome: text,
      history: scheduleHistory(row, { kind: "error", text }, Date.now()),
    }));
    outcomeRow(schedule, text, false, now);
  }
}

async function tick(hooks: ScheduleEngineHooks): Promise<void> {
  const now = Date.now();
  const due = loadSchedules().filter(
    (schedule) =>
      schedule.enabled &&
      schedule.nextRunAt > 0 &&
      schedule.nextRunAt <= now &&
      !inflight.has(schedule.id),
  );
  for (const schedule of due) {
    inflight.add(schedule.id);
    const manual = queuedRuns.delete(schedule.id);
    try {
      // Re-read inside the run — a disable/edit during an earlier fire
      // must not let this one use stale instructions.
      const current = loadSchedules().find((row) => row.id === schedule.id);
      if (current?.enabled && current.nextRunAt <= now) {
        await fire(current, hooks, now, manual);
      }
    } finally {
      inflight.delete(schedule.id);
    }
  }
}
