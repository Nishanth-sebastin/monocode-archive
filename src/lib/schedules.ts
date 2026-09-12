import { resolveAttentionWhere } from "./attention";
import type { HarnessId } from "./session";

/**
 * Schedule model (#24). A schedule fires editable instructions at an
 * explicitly bound checkout/agent target — one-shot, daily, or weekly on
 * local wall-clock time. Persisted under `monocode.schedules.v1` so the next
 * run survives restart; the engine is foreground-only, which the UI states
 * plainly — nothing runs while MonoCode is closed.
 *
 * Missed runs are bounded: on wake/restart a recurring schedule runs once
 * for the latest slot and records how many slots were skipped — never a
 * burst of back-runs. A one-shot overdue by more than `CATCH_UP_MAX_MS` is
 * marked missed instead of firing stale instructions.
 */

export type ScheduleCadence =
  | { kind: "once"; at: number }
  | { kind: "daily"; time: string }
  | { kind: "weekly"; time: string; weekday: number };

export type ScheduleMode = "notify" | "draft" | "run";

export type ScheduleRunEntry = {
  at: number;
  kind: "run" | "skip" | "missed" | "error";
  text: string;
};

export type ScheduleTarget = {
  cwd: string;
  harness: HarnessId;
  model: string;
  /** Bind runs to an existing conversation; absent → a new one per run. */
  sessionId?: string;
};

export type Schedule = {
  id: string;
  name: string;
  /** The prompt body sent on each run — editable any time. */
  instructions: string;
  enabled: boolean;
  cadence: ScheduleCadence;
  mode: ScheduleMode;
  target: ScheduleTarget;
  /** Persisted next fire time — restart-safe; 0 means "compute on load". */
  nextRunAt: number;
  lastRunAt?: number;
  lastOutcome?: string;
  history: ScheduleRunEntry[];
  createdAt: number;
};

const KEY = "monocode.schedules.v1";
export const SCHEDULES_CHANGED = "monocode:schedules-changed";
const MAX_SCHEDULES = 50;
export const MAX_SCHEDULE_HISTORY = 20;
/** One-shot schedules older than this on wake are missed, not run — a
 * day-old "deploy now" instruction must not fire on launch. */
export const CATCH_UP_MAX_MS = 24 * 3600 * 1000;
/** Skipped-slot count is reported but capped — history stays readable. */
const MAX_REPORTED_SKIPS = 99;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const clean = (value: unknown, max = 2000): string | undefined =>
  typeof value === "string" && value.trim()
    ? value.trim().slice(0, max)
    : undefined;

const isTime = (value: unknown): value is string =>
  typeof value === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(value);

function isCadence(value: unknown): value is ScheduleCadence {
  if (!isRecord(value)) return false;
  switch (value.kind) {
    case "once":
      return typeof value.at === "number" && Number.isFinite(value.at);
    case "daily":
      return isTime(value.time);
    case "weekly":
      return (
        isTime(value.time) &&
        Number.isInteger(value.weekday) &&
        (value.weekday as number) >= 0 &&
        (value.weekday as number) <= 6
      );
    default:
      return false;
  }
}

/**
 * Next occurrence strictly after `after` (epoch ms), or null for a spent
 * one-shot. Wall-clock fields are interpreted in the *local* timezone —
 * Date arithmetic resolves DST transitions naturally: a daily 09:00 fires
 * at 09:00 local even across a clock change, and a spring-forward gap like
 * 02:30 resolves forward rather than firing twice or never.
 */
export function nextOccurrence(
  cadence: ScheduleCadence,
  after: number,
): number | null {
  if (cadence.kind === "once") return cadence.at > after ? cadence.at : null;
  const [hour, minute] = cadence.time.split(":").map(Number);
  const day = new Date(after);
  day.setSeconds(0, 0);
  day.setHours(hour, minute, 0, 0);
  if (day.getTime() <= after) day.setDate(day.getDate() + 1);
  if (cadence.kind === "daily") return day.getTime();
  // Weekly: walk forward to the matching weekday.
  let guard = 0;
  while (day.getDay() !== cadence.weekday && guard < 8) {
    day.setDate(day.getDate() + 1);
    guard += 1;
  }
  return guard < 8 ? day.getTime() : null;
}

/** How many slots were skipped between `missedFrom` and `now` — recurring
 * schedules only. Bounded; used for history text, not for catch-up runs. */
export function skippedSlots(cadence: ScheduleCadence, missedFrom: number, now: number): number {
  if (cadence.kind === "once") return 0;
  let count = 0;
  let cursor = missedFrom;
  for (;;) {
    const next = nextOccurrence(cadence, cursor);
    if (next === null || next > now || count >= MAX_REPORTED_SKIPS) break;
    count += 1;
    cursor = next;
  }
  return count;
}

function sanitize(value: unknown): Schedule | null {
  if (!isRecord(value)) return null;
  const id = clean(value.id, 128);
  const name = clean(value.name, 160);
  const instructions = clean(value.instructions, 8000);
  if (!id || !name || !instructions || !isCadence(value.cadence)) return null;
  const target =
    isRecord(value.target) && clean(value.target.cwd)
      ? {
          cwd: clean(value.target.cwd)!,
          harness: value.target.harness as HarnessId,
          model: clean(value.target.model, 120) ?? "",
          ...(clean(value.target.sessionId, 128)
            ? { sessionId: clean(value.target.sessionId, 128) }
            : {}),
        }
      : null;
  if (!target) return null;
  const history: ScheduleRunEntry[] = [];
  if (Array.isArray(value.history)) {
    for (const entry of value.history.slice(-MAX_SCHEDULE_HISTORY)) {
      if (!isRecord(entry)) continue;
      const text = clean(entry.text, 500);
      const kind =
        entry.kind === "run" ||
        entry.kind === "skip" ||
        entry.kind === "missed" ||
        entry.kind === "error"
          ? entry.kind
          : null;
      const at =
        typeof entry.at === "number" && Number.isFinite(entry.at)
          ? entry.at
          : 0;
      if (text && kind && at) history.push({ at, kind, text });
    }
  }
  return {
    id,
    name,
    instructions,
    enabled: value.enabled !== false,
    cadence: value.cadence,
    mode:
      value.mode === "draft" || value.mode === "run" ? value.mode : "notify",
    target,
    nextRunAt:
      typeof value.nextRunAt === "number" && Number.isFinite(value.nextRunAt)
        ? value.nextRunAt
        : 0,
    ...(typeof value.lastRunAt === "number" && Number.isFinite(value.lastRunAt)
      ? { lastRunAt: value.lastRunAt }
      : {}),
    ...(clean(value.lastOutcome, 240)
      ? { lastOutcome: clean(value.lastOutcome, 240) }
      : {}),
    history,
    createdAt:
      typeof value.createdAt === "number" && Number.isFinite(value.createdAt)
        ? value.createdAt
        : Date.now(),
  };
}

export function loadSchedules(): Schedule[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const schedules: Schedule[] = [];
    const seen = new Set<string>();
    for (const entry of parsed.slice(0, MAX_SCHEDULES)) {
      const schedule = sanitize(entry);
      if (schedule && !seen.has(schedule.id)) {
        seen.add(schedule.id);
        schedules.push(schedule);
      }
    }
    return schedules;
  } catch {
    return [];
  }
}

function writeSchedules(schedules: Schedule[]) {
  try {
    localStorage.setItem(KEY, JSON.stringify(schedules));
  } catch {
    /* storage full or unavailable — keep the in-memory view */
  }
  if (typeof window !== "undefined") {
    window.dispatchEvent(new Event(SCHEDULES_CHANGED));
  }
}

export function schedulesSnapshot(): string | null {
  try {
    return localStorage.getItem(KEY);
  } catch {
    return null;
  }
}

export function subscribeSchedules(listener: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  const onStorage = (event: StorageEvent) => {
    if (event.key === null || event.key === KEY) listener();
  };
  window.addEventListener(SCHEDULES_CHANGED, listener);
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener(SCHEDULES_CHANGED, listener);
    window.removeEventListener("storage", onStorage);
  };
}

export type ScheduleDraft = {
  name: string;
  instructions: string;
  enabled?: boolean;
  cadence: ScheduleCadence;
  mode?: ScheduleMode;
  target: ScheduleTarget;
};

/**
 * Create or update a schedule. Editing the cadence re-arms `nextRunAt` from
 * now — a re-pointed schedule never inherits a stale fire time. `run` mode
 * requires an explicit target checkout, matching watcher run-mode rules.
 */
export function saveSchedule(
  draft: ScheduleDraft,
  existingId?: string,
): { schedule?: Schedule; error?: string } {
  const schedules = loadSchedules();
  const name = draft.name.trim();
  if (!name) return { error: "Name the schedule." };
  if (!draft.instructions.trim())
    return { error: "Write the instructions this schedule sends." };
  if (!isCadence(draft.cadence)) return { error: "Pick a valid time." };
  // A one-shot in the past can never fire — saving it would leave a dead,
  // enabled-looking schedule, so edits face the same check as new rows.
  if (draft.cadence.kind === "once" && draft.cadence.at <= Date.now())
    return { error: "Pick a time in the future." };
  if (!draft.target.cwd.trim())
    return { error: "Choose the checkout runs happen in." };
  const existing = existingId
    ? schedules.find((row) => row.id === existingId)
    : undefined;
  const cadenceChanged =
    !existing || JSON.stringify(existing.cadence) !== JSON.stringify(draft.cadence);
  const next: Schedule = {
    id: existingId ?? crypto.randomUUID(),
    name,
    instructions: draft.instructions.trim(),
    enabled: draft.enabled !== false,
    cadence: draft.cadence,
    mode: draft.mode === "draft" || draft.mode === "run" ? draft.mode : "notify",
    target: {
      cwd: draft.target.cwd.trim(),
      harness: draft.target.harness,
      model: draft.target.model.trim(),
      ...(draft.target.sessionId ? { sessionId: draft.target.sessionId } : {}),
    },
    nextRunAt: cadenceChanged
      ? (nextOccurrence(draft.cadence, Date.now()) ?? 0)
      : existing.nextRunAt,
    ...(existing?.lastRunAt ? { lastRunAt: existing.lastRunAt } : {}),
    ...(existing?.lastOutcome ? { lastOutcome: existing.lastOutcome } : {}),
    history: existing?.history ?? [],
    createdAt: existing?.createdAt ?? Date.now(),
  };
  // A spent one-shot that is being re-armed gets a fresh occurrence.
  if (next.nextRunAt === 0)
    next.nextRunAt = nextOccurrence(draft.cadence, Date.now()) ?? 0;
  const list = existing
    ? schedules.map((row) => (row.id === existingId ? next : row))
    : [...schedules, next];
  if (list.length > MAX_SCHEDULES) return { error: "Too many schedules." };
  writeSchedules(list);
  return { schedule: next };
}

export function removeSchedule(id: string) {
  writeSchedules(loadSchedules().filter((row) => row.id !== id));
  // Due/outcome rows from a deleted schedule can never change or resolve —
  // drop them rather than leaving dead rows in the queue.
  resolveAttentionWhere(
    (row) => row.source?.kind === "schedule" && row.source.id === id,
  );
}

export function setScheduleEnabled(id: string, enabled: boolean) {
  updateSchedule(id, (schedule) => {
    if (!enabled) return { ...schedule, enabled };
    // Resuming re-arms from now — a paused schedule never fires a stale
    // slot. For a one-shot whose time passed while paused there is no next
    // occurrence: mark it missed rather than firing late instructions.
    const next = nextOccurrence(schedule.cadence, Date.now());
    if (next === null) {
      return {
        ...schedule,
        enabled: true,
        nextRunAt: 0,
        lastOutcome: "Missed — paused past the scheduled time.",
        history: scheduleHistory(
          schedule,
          { kind: "missed", text: "Missed — paused past the scheduled time." },
        ),
      };
    }
    return { ...schedule, enabled: true, nextRunAt: next };
  });
}

/** Single-writer update — engine and UI both go through this. */
export function updateSchedule(
  id: string,
  update: (schedule: Schedule) => Schedule,
) {
  const schedules = loadSchedules();
  const index = schedules.findIndex((row) => row.id === id);
  if (index < 0) return;
  const next = update(schedules[index]);
  next.history = next.history.slice(-MAX_SCHEDULE_HISTORY);
  writeSchedules(schedules.map((row, i) => (i === index ? next : row)));
}

export function scheduleHistory(
  schedule: Schedule,
  entry: Omit<ScheduleRunEntry, "at">,
  at = Date.now(),
): ScheduleRunEntry[] {
  return [...schedule.history, { ...entry, at }].slice(-MAX_SCHEDULE_HISTORY);
}

/** One-line cadence label with the local timezone — "Weekly · Mon 09:00". */
export function scheduleCadenceLabel(cadence: ScheduleCadence): string {
  const weekday = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  switch (cadence.kind) {
    case "once":
      return `Once · ${new Date(cadence.at).toLocaleString()}`;
    case "daily":
      return `Daily · ${cadence.time}`;
    case "weekly":
      return `Weekly · ${weekday[cadence.weekday]} ${cadence.time}`;
  }
}

export function scheduleNextLabel(schedule: Schedule, now = Date.now()): string {
  if (!schedule.enabled) return "Paused";
  if (!schedule.nextRunAt) return "Not scheduled";
  if (schedule.nextRunAt <= now) return "Due now";
  const diff = schedule.nextRunAt - now;
  const when = new Date(schedule.nextRunAt).toLocaleString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
  if (diff < 3600_000) return `${when} · in ${Math.max(1, Math.round(diff / 60_000))}m`;
  if (diff < 86400_000) return `${when} · in ${Math.round(diff / 3600_000)}h`;
  return when;
}

/** Local timezone name for the sheet/row caption. */
export function scheduleTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "local time";
  } catch {
    return "local time";
  }
}

/** Fired on `window` to open the schedule sheet — surfaces emit, App hosts. */
export const OPEN_SCHEDULE_SHEET = "monocode:open-schedule-sheet";

export type ScheduleSheetRequest = {
  /** Prefilled target checkout — usually the active project. */
  cwd?: string;
  /** Edit this schedule instead of creating a new one. */
  existing?: Schedule;
};

export function openScheduleSheet(request: ScheduleSheetRequest = {}) {
  window.dispatchEvent(
    new CustomEvent<ScheduleSheetRequest>(OPEN_SCHEDULE_SHEET, {
      detail: request,
    }),
  );
}
