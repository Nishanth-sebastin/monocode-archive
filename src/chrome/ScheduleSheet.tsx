import { useMemo, useState } from "react";
import { Modal } from "./Modal";
import { Select } from "./Select";
import {
  HARNESS_TITLE,
  sessionDisplayTitle,
  sessionWorkCwd,
  HARNESSES,
  type HarnessId,
  type Session,
} from "../lib/session";
import {
  saveSchedule,
  scheduleCadenceLabel,
  scheduleTimezone,
  type ScheduleCadence,
  type ScheduleMode,
  type ScheduleSheetRequest,
} from "../lib/schedules";

const inputClass =
  "w-full rounded-lg border border-content/10 bg-content/5 px-2.5 py-1.5 text-[13px] text-content outline-none ring-accent/40 focus:ring-1";
const labelClass =
  "mb-1 block text-[11px] font-medium uppercase tracking-wide text-content/45";

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map(
  (label, index) => ({ value: String(index), label }),
);

/** datetime-local value ↔ epoch ms, in the local timezone. */
const toLocalInput = (ms: number) => {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

/**
 * Create/edit a schedule (#24). Runs while MonoCode is open — the sheet and
 * the Automations page both say so. Times are local wall-clock.
 */
export function ScheduleSheet({
  request,
  sessions,
  defaultCwd,
  onClose,
}: {
  request: ScheduleSheetRequest;
  sessions: Session[];
  defaultCwd: string;
  onClose: () => void;
}) {
  const existing = request.existing;
  const [name, setName] = useState(existing?.name ?? "");
  const [instructions, setInstructions] = useState(
    existing?.instructions ?? "",
  );
  const [kind, setKind] = useState<ScheduleCadence["kind"]>(
    existing?.cadence.kind ?? "once",
  );
  const [onceAt, setOnceAt] = useState(() =>
    toLocalInput(
      existing?.cadence.kind === "once"
        ? existing.cadence.at
        : Date.now() + 3600_000,
    ),
  );
  const [time, setTime] = useState(
    existing?.cadence.kind === "daily" || existing?.cadence.kind === "weekly"
      ? existing.cadence.time
      : "09:00",
  );
  const [weekday, setWeekday] = useState(
    String(
      existing?.cadence.kind === "weekly"
        ? existing.cadence.weekday
        : new Date().getDay(),
    ),
  );
  const [mode, setMode] = useState<ScheduleMode>(existing?.mode ?? "notify");
  const [enabled, setEnabled] = useState(existing?.enabled ?? true);
  const [targetCwd, setTargetCwd] = useState(
    existing?.target.cwd ?? request.cwd ?? defaultCwd,
  );
  const [targetHarness, setTargetHarness] = useState<HarnessId>(
    existing?.target.harness ?? "claude",
  );
  const [targetModel, setTargetModel] = useState(existing?.target.model ?? "");
  const [targetSessionId, setTargetSessionId] = useState(
    existing?.target.sessionId ?? "",
  );
  const [error, setError] = useState("");

  const sessionOptions = useMemo(
    () =>
      sessions
        .filter(
          (session) =>
            !session.inboxAsk && sessionWorkCwd(session) === targetCwd,
        )
        .map((session) => ({
          value: session.id,
          label: sessionDisplayTitle(session.title, session.harness),
        })),
    [sessions, targetCwd],
  );

  const cadence: ScheduleCadence = useMemo(() => {
    if (kind === "once") {
      const at = new Date(onceAt).getTime();
      return { kind: "once", at: Number.isFinite(at) ? at : 0 };
    }
    if (kind === "weekly")
      return { kind: "weekly", time, weekday: Number(weekday) };
    return { kind: "daily", time };
  }, [kind, onceAt, time, weekday]);

  const save = () => {
    const result = saveSchedule(
      {
        name,
        instructions,
        enabled,
        cadence,
        mode,
        target: {
          cwd: targetCwd,
          harness: targetHarness,
          model: targetModel,
          ...(targetSessionId ? { sessionId: targetSessionId } : {}),
        },
      },
      existing?.id,
    );
    if (result.error) {
      setError(result.error);
      return;
    }
    onClose();
  };

  return (
    <Modal
      onClose={onClose}
      title={existing ? "Edit schedule" : "New schedule"}
      description={`Runs only while MonoCode is open · times are ${scheduleTimezone()}`}
      size="md"
      className="max-h-[80vh]"
    >
      <div className="space-y-4 p-4">
        <div>
          <label className={labelClass} htmlFor="schedule-name">
            Name
          </label>
          <input
            id="schedule-name"
            className={inputClass}
            value={name}
            onChange={(event) => setName(event.target.value)}
            maxLength={160}
            placeholder="Morning standup prep"
          />
        </div>

        <div>
          <label className={labelClass} htmlFor="schedule-instructions">
            Instructions
          </label>
          <textarea
            id="schedule-instructions"
            className={`${inputClass} min-h-20 resize-y`}
            value={instructions}
            onChange={(event) => setInstructions(event.target.value)}
            maxLength={8000}
            placeholder="What the agent should do when this runs."
          />
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <span className={labelClass}>Repeats</span>
            <Select
              label="Cadence"
              value={kind}
              options={[
                { value: "once", label: "Once" },
                { value: "daily", label: "Daily" },
                { value: "weekly", label: "Weekly" },
              ]}
              onChange={(value) => setKind(value as ScheduleCadence["kind"])}
            />
          </div>
          {kind === "once" ? (
            <div>
              <label className={labelClass} htmlFor="schedule-once">
                When
              </label>
              <input
                id="schedule-once"
                type="datetime-local"
                className={inputClass}
                value={onceAt}
                onChange={(event) => setOnceAt(event.target.value)}
              />
            </div>
          ) : (
            <div>
              <label className={labelClass} htmlFor="schedule-time">
                Time
              </label>
              <input
                id="schedule-time"
                type="time"
                className={inputClass}
                value={time}
                onChange={(event) => setTime(event.target.value)}
              />
            </div>
          )}
        </div>
        {kind === "weekly" ? (
          <div>
            <span className={labelClass}>Day</span>
            <Select
              label="Weekday"
              value={weekday}
              options={WEEKDAYS}
              onChange={setWeekday}
            />
          </div>
        ) : null}
        <p className="text-[11px] text-content/45">
          {scheduleCadenceLabel(cadence)} · {scheduleTimezone()}
        </p>

        <div>
          <span className={labelClass}>When it fires</span>
          <Select
            label="Mode"
            value={mode}
            options={[
              { value: "notify", label: "Notify in the queue" },
              { value: "draft", label: "Prepare a draft" },
              { value: "run", label: "Run the instructions" },
            ]}
            onChange={(value) => setMode(value as ScheduleMode)}
          />
          <p className="mt-1 text-[11px] text-content/45">
            {mode === "run"
              ? "Runs automatically in the bound checkout — a busy conversation skips the run."
              : mode === "draft"
                ? "Opens the context picker with the instructions — you confirm before it sends."
                : "Adds a row to the Attention queue — nothing is sent."}
          </p>
        </div>

        <div className="space-y-3 rounded-lg border border-content/10 p-3">
          <div>
            <label className={labelClass} htmlFor="schedule-target-cwd">
              Checkout
            </label>
            <input
              id="schedule-target-cwd"
              className={inputClass}
              value={targetCwd}
              onChange={(event) => setTargetCwd(event.target.value)}
              placeholder="/path/to/checkout"
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <span className={labelClass}>Agent</span>
              <Select
                label="Harness"
                value={targetHarness}
                options={HARNESSES.map((id) => ({
                  value: id,
                  label: HARNESS_TITLE[id],
                }))}
                onChange={(value) => setTargetHarness(value as HarnessId)}
              />
            </div>
            <div>
              <label className={labelClass} htmlFor="schedule-target-model">
                Model (optional)
              </label>
              <input
                id="schedule-target-model"
                className={inputClass}
                value={targetModel}
                onChange={(event) => setTargetModel(event.target.value)}
                placeholder="Harness default"
              />
            </div>
          </div>
          <div>
            <span className={labelClass}>Conversation</span>
            <Select
              label="Bound conversation"
              value={targetSessionId}
              options={[
                { value: "", label: "A new conversation each run" },
                ...sessionOptions,
              ]}
              onChange={setTargetSessionId}
            />
          </div>
        </div>

        <label className="flex items-center gap-2 text-[13px] text-content/80">
          <input
            type="checkbox"
            checked={enabled}
            onChange={(event) => setEnabled(event.target.checked)}
          />
          Enabled — runs while MonoCode is open
        </label>

        {error ? (
          <p role="alert" className="text-[12px] text-red-400">
            {error}
          </p>
        ) : null}

        <div className="flex justify-end gap-2">
          <button
            type="button"
            className="rounded-md px-3 py-1.5 text-[12px] text-content/60 hover:bg-content/10"
            onClick={onClose}
          >
            Cancel
          </button>
          <button
            type="button"
            className="rounded-md bg-accent px-3 py-1.5 text-[12px] font-medium text-white hover:bg-accent/90"
            onClick={save}
          >
            {existing ? "Save schedule" : "Create schedule"}
          </button>
        </div>
      </div>
    </Modal>
  );
}
