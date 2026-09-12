import {
  emitAttention,
  resolveAttentionWhere,
  type AttentionItem,
} from "./attention";
import { pollWatcherSource, type WatcherPoll } from "./watcherPoll";
import {
  WATCHERS_CHANGED,
  loadWatchers,
  updateWatcher,
  watcherHistory,
  watcherPollKey,
  type Watcher,
} from "./watchers";

/**
 * The watcher runtime (#23). One interval for every watcher — there are no
 * per-row or per-watcher timers. Each tick polls only watchers whose
 * `nextPollAt` has come due, and watchers sharing a `watcherPollKey` (same
 * repo/source) share one provider request.
 *
 * Disabled watchers never enter a tick, so a fully disabled set polls zero
 * times. The engine is foreground-only: it lives in the WebView and stops
 * when MonoCode closes.
 */

export type WatcherEngineHooks = {
  /** "Prepare draft" mode — opens the review surface for the emitted item. */
  prepareDraft?: (watcher: Watcher, item: AttentionItem) => void;
  /** "Run action" mode — dispatches the saved action into the bound target.
   * Returns an error string on refusal (busy agent, stale binding). */
  runAction?: (watcher: Watcher, item: AttentionItem) => Promise<string | void>;
};

const TICK_MS = 15_000;
/** Failure backoff tops out at 30 minutes. */
const MAX_BACKOFF_SEC = 1800;
/** Idle polls stretch the interval to at most 4x the base cadence. */
const IDLE_STRETCH_MAX = 4;
/** How many identical consecutive failures to log once. */
let timer: number | undefined;
const inflight = new Set<string>();
const queuedPolls = new Set<string>();

export function startWatcherEngine(hooks: WatcherEngineHooks): () => void {
  stopWatcherEngine();
  const onChange = () => void tick(hooks);
  window.addEventListener(WATCHERS_CHANGED, onChange);
  timer = window.setInterval(() => void tick(hooks), TICK_MS);
  void tick(hooks);
  return () => {
    window.removeEventListener(WATCHERS_CHANGED, onChange);
    stopWatcherEngine();
  };
}

export function stopWatcherEngine() {
  if (timer !== undefined) window.clearInterval(timer);
  timer = undefined;
}

/** "Run check now" — bypasses the schedule for one watcher. Shared-poll
 * peers still ride the same provider request when the group runs. */
export function pollWatcherNow(id: string) {
  updateWatcher(id, (watcher) => ({ ...watcher, nextPollAt: 0 }));
  queuedPolls.add(id);
}

export function watcherDueLabel(watcher: Watcher, now = Date.now()): string {
  if (!watcher.enabled) return "Paused";
  if (!watcher.nextPollAt || watcher.nextPollAt <= now) return "Due now";
  const sec = Math.round((watcher.nextPollAt - now) / 1000);
  if (sec < 60) return `Next check in ${sec}s`;
  return `Next check in ${Math.round(sec / 60)}m`;
}

/** Interval after a successful poll: idle polls stretch, events reset. */
function nextIntervalSec(watcher: Watcher, hadEvents: boolean): number {
  if (hadEvents) return watcher.intervalSec;
  const stretch = Math.min(
    IDLE_STRETCH_MAX,
    1 + Math.floor(watcher.idleStreak / 4),
  );
  return watcher.intervalSec * stretch;
}

/** Interval after a failed poll: exponential backoff, capped. */
function failureIntervalSec(watcher: Watcher): number {
  return Math.min(
    MAX_BACKOFF_SEC,
    watcher.intervalSec * 2 ** Math.min(watcher.failures, 8),
  );
}

function recordError(watcher: Watcher, error: unknown, now: number): Watcher {
  const text = (error instanceof Error ? error.message : String(error)).slice(
    0,
    500,
  );
  const next: Watcher = {
    ...watcher,
    failures: watcher.failures + 1,
    lastError: text,
    lastPollAt: now,
    nextPollAt: now + failureIntervalSec(watcher) * 1000,
  };
  // Log the first failure and every time the error text changes — not every
  // consecutive identical failure.
  if (watcher.lastError !== text || watcher.failures === 0) {
    next.history = watcherHistory(next, { kind: "error", text }, now);
  }
  return next;
}

function applyPollResult(
  watcher: Watcher,
  result: WatcherPoll,
  now: number,
): { watcher: Watcher; fresh: { key: string; item: AttentionItem }[] } {
  const keys = new Set(result.conditions.map((condition) => condition.key));
  const seen = new Set(watcher.seen);
  const fresh: { key: string; item: AttentionItem }[] = [];
  let history = watcher.history;
  for (const condition of result.conditions) {
    const key = `watcher:${watcher.id}:${condition.key}`;
    const item: AttentionItem = {
      ...condition.item,
      key,
      signature: condition.signature,
      source: { kind: "watcher", id: watcher.id },
    };
    emitAttention(item);
    if (!seen.has(condition.key)) {
      fresh.push({ key: condition.key, item });
      seen.add(condition.key);
      history = [...history, { kind: "event", text: item.title, at: now }];
    }
  }
  // Conditions absent from this read resolved — drop their rows and un-seen
  // them so a re-trigger counts as a new event.
  const gone = watcher.seen.filter((key) => !keys.has(key));
  if (gone.length) {
    const goneKeys = new Set(
      gone.map((key) => `watcher:${watcher.id}:${key}`),
    );
    resolveAttentionWhere(
      (row) => !!row.source && row.source.kind === "watcher" && row.source.id === watcher.id && goneKeys.has(row.key),
    );
    for (const key of gone) seen.delete(key);
  }
  const hadEvents = fresh.length > 0;
  const next: Watcher = {
    ...watcher,
    cursor: result.cursor ?? watcher.cursor,
    seen: [...seen],
    failures: 0,
    lastError: undefined,
    idleStreak: hadEvents ? 0 : watcher.idleStreak + 1,
    lastPollAt: now,
    ...(hadEvents ? { lastEventAt: now } : {}),
    nextPollAt: now + nextIntervalSec(watcher, hadEvents) * 1000,
    history,
  };
  return { watcher: next, fresh };
}

async function runPollGroup(
  watchers: Watcher[],
  hooks: WatcherEngineHooks,
): Promise<void> {
  const key = watcherPollKey(watchers[0]);
  if (inflight.has(key)) return;
  inflight.add(key);
  try {
    const result = await pollWatcherSource(watchers[0]);
    const now = Date.now();
    for (const watcher of watchers) {
      const { watcher: next, fresh } = applyPollResult(watcher, result, now);
      updateWatcher(watcher.id, () => next);
      for (const event of fresh) {
        dispatchEvent(watcher, event.item, hooks, now);
      }
    }
  } catch (error) {
    const now = Date.now();
    for (const watcher of watchers) {
      updateWatcher(watcher.id, (row) => recordError(row, error, now));
      emitAttention({
        key: `watcher-error:${watcher.id}`,
        kind: "watcher",
        title: `${watcher.name} — check failed`,
        detail: error instanceof Error ? error.message.slice(0, 200) : undefined,
        urgency: 1,
        at: now,
        signature: `error:${watcher.failures > 2 ? "persistent" : "transient"}:${error instanceof Error ? error.message.slice(0, 120) : "unknown"}`,
        source: { kind: "watcher", id: watcher.id },
        action: { kind: "open-automations", watcherId: watcher.id },
      });
    }
  } finally {
    inflight.delete(key);
  }
}

/** Emit succeeded — apply the watcher's action mode once per new event. */
function dispatchEvent(
  watcher: Watcher,
  item: AttentionItem,
  hooks: WatcherEngineHooks,
  now: number,
) {
  if (watcher.mode === "draft" && hooks.prepareDraft) {
    updateWatcher(watcher.id, (row) => ({
      ...row,
      history: watcherHistory(row, { kind: "run", text: `Prepared draft · ${item.title}` }, now),
    }));
    try {
      hooks.prepareDraft(watcher, item);
    } catch {
      /* draft prep is best-effort — the row stands either way */
    }
    return;
  }
  if (watcher.mode !== "run" || !hooks.runAction || !watcher.actionId) return;
  if (watcher.lastRunAt && now - watcher.lastRunAt < watcher.cooldownSec * 1000) {
    updateWatcher(watcher.id, (row) => ({
      ...row,
      history: watcherHistory(
        row,
        { kind: "skip", text: `Cooldown — skipped run for ${item.title}` },
        now,
      ),
    }));
    return;
  }
  updateWatcher(watcher.id, (row) => ({
    ...row,
    lastRunAt: now,
    history: watcherHistory(row, { kind: "run", text: `Ran action · ${item.title}` }, now),
  }));
  void hooks
    .runAction(watcher, item)
    .then((error) => {
      if (error) {
        updateWatcher(watcher.id, (row) => ({
          ...row,
          history: watcherHistory(row, { kind: "error", text: error }, Date.now()),
        }));
      }
    })
    .catch((error: unknown) => {
      updateWatcher(watcher.id, (row) => ({
        ...row,
        history: watcherHistory(
          row,
          {
            kind: "error",
            text: error instanceof Error ? error.message : String(error),
          },
          Date.now(),
        ),
      }));
    });
}

async function tick(hooks: WatcherEngineHooks): Promise<void> {
  const now = Date.now();
  const due = loadWatchers().filter(
    (watcher) =>
      watcher.enabled &&
      (watcher.nextPollAt <= now || queuedPolls.has(watcher.id)),
  );
  if (!due.length) return;
  for (const watcher of due) queuedPolls.delete(watcher.id);
  // Share one provider read per repo/source — group by poll key.
  const groups = new Map<string, Watcher[]>();
  for (const watcher of due) {
    const key = watcherPollKey(watcher);
    groups.set(key, [...(groups.get(key) ?? []), watcher]);
  }
  // Bound concurrent provider work — groups run in pairs.
  const pending = [...groups.values()];
  while (pending.length) {
    await Promise.all(
      pending.splice(0, 2).map((group) => runPollGroup(group, hooks)),
    );
  }
}
