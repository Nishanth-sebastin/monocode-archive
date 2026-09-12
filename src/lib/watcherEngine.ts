import {
  emitAttentionAll,
  emittedAttention,
  removeAttention,
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
   * Returns `{skipped}` when the target refused (busy agent) or `{error}`
   * on a failed dispatch. */
  runAction?: (
    watcher: Watcher,
    item: AttentionItem,
  ) => Promise<{ skipped?: string; error?: string } | void>;
};

const TICK_MS = 15_000;
/** Failure backoff tops out at 30 minutes. */
const MAX_BACKOFF_SEC = 1800;
/** Idle polls stretch the interval to at most 4x the base cadence. */
const IDLE_STRETCH_MAX = 4;
/** A provider call that never settles must not wedge its poll group. */
const POLL_TIMEOUT_MS = 120_000;
let timer: number | undefined;
let changeListener: (() => void) | undefined;
const inflight = new Set<string>();
const queuedPolls = new Set<string>();

export function startWatcherEngine(hooks: WatcherEngineHooks): () => void {
  stopWatcherEngine();
  changeListener = () => void tick(hooks);
  window.addEventListener(WATCHERS_CHANGED, changeListener);
  timer = window.setInterval(() => void tick(hooks), TICK_MS);
  void tick(hooks);
  return () => stopWatcherEngine();
}

export function stopWatcherEngine() {
  if (timer !== undefined) window.clearInterval(timer);
  timer = undefined;
  if (changeListener) {
    window.removeEventListener(WATCHERS_CHANGED, changeListener);
    changeListener = undefined;
  }
  queuedPolls.clear();
  // A wedged provider call must not block its group after a restart; any
  // late-settling promise still writes through `updateWatcher`.
  inflight.clear();
}

/** "Run check now" — bypasses the schedule for one watcher. Shared-poll
 * peers still ride the same provider request when the group runs. The flag
 * is set before the store write so a synchronous tick sees it; if the group
 * is already inflight the flag survives and the next tick retries. */
export function pollWatcherNow(id: string) {
  queuedPolls.add(id);
  updateWatcher(id, (watcher) => ({ ...watcher, nextPollAt: 0 }));
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

type PollOutcome = {
  watcher: Watcher;
  items: AttentionItem[];
  fresh: { key: string; item: AttentionItem }[];
};

/**
 * Merge one poll result into the watcher row. `previousSignatures` is the
 * emitted store read once per group — a condition whose signature moved is
 * a new event (state changed → resurface and re-dispatch), not a replay.
 */
function applyPollResult(
  watcher: Watcher,
  result: WatcherPoll,
  now: number,
  previousSignatures: Map<string, string | undefined>,
): PollOutcome {
  const keys = new Set(result.conditions.map((condition) => condition.key));
  const seen = new Set(watcher.seen);
  const items: AttentionItem[] = [];
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
    items.push(item);
    const signatureMoved =
      previousSignatures.get(key) !== undefined &&
      previousSignatures.get(key) !== condition.signature;
    if (!seen.has(condition.key) || signatureMoved) {
      fresh.push({ key: condition.key, item });
      history = [...history, { kind: "event", text: item.title, at: now }];
    }
    seen.add(condition.key);
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
  return { watcher: next, items, fresh };
}

async function runPollGroup(
  watchers: Watcher[],
  hooks: WatcherEngineHooks,
): Promise<void> {
  const key = watcherPollKey(watchers[0]);
  if (inflight.has(key)) return;
  inflight.add(key);
  // The group is running — consume any queued "check now" flags so they
  // don't trigger a redundant poll on the next tick.
  for (const watcher of watchers) queuedPolls.delete(watcher.id);
  try {
    const result = await Promise.race([
      pollWatcherSource(watchers[0]),
      new Promise<never>((_resolve, reject) => {
        setTimeout(
          () => reject(new Error("Poll timed out")),
          POLL_TIMEOUT_MS,
        );
      }),
    ]);
    const now = Date.now();
    // Signature-move detection needs the emitted rows as they were before
    // this poll — read the store once for the whole group.
    const previousSignatures = new Map(
      emittedAttention().map((row) => [row.key, row.signature] as const),
    );
    const items: AttentionItem[] = [];
    const dispatches: { watcher: Watcher; item: AttentionItem }[] = [];
    for (const watcher of watchers) {
      let fresh: { key: string; item: AttentionItem }[] = [];
      let applied: Watcher | undefined;
      // Compute from the row inside the updater — edits made while the
      // provider call was in flight (pause, re-point) must survive.
      updateWatcher(watcher.id, (row) => {
        const outcome = applyPollResult(row, result, now, previousSignatures);
        fresh = outcome.fresh;
        items.push(...outcome.items);
        applied = outcome.watcher;
        return outcome.watcher;
      });
      // A healthy poll clears any earlier "check failed" row.
      removeAttention(`watcher-error:${watcher.id}`);
      if (!applied) continue; // watcher was removed mid-poll
      for (const event of fresh) {
        dispatches.push({ watcher: applied, item: event.item });
      }
    }
    // Emit before dispatching — a draft or run never opens ahead of its row.
    emitAttentionAll(items);
    for (const { watcher, item } of dispatches) {
      dispatchEvent(watcher, item, hooks, now);
    }
  } catch (error) {
    const now = Date.now();
    const items: AttentionItem[] = [];
    for (const watcher of watchers) {
      // Apply the failure inside the updater — the stored row's `failures`
      // is fresher than the tick-time snapshot this group started from.
      let applied: Watcher | undefined;
      updateWatcher(watcher.id, (row) => {
        applied = recordError(row, error, now);
        return applied;
      });
      if (!applied) continue; // watcher was removed mid-poll
      items.push({
        key: `watcher-error:${watcher.id}`,
        kind: "watcher",
        title: `${watcher.name} — check failed`,
        detail: error instanceof Error ? error.message.slice(0, 200) : undefined,
        urgency: 1,
        at: now,
        signature: `error:${applied.failures > 2 ? "persistent" : "transient"}:${error instanceof Error ? error.message.slice(0, 120) : "unknown"}`,
        source: { kind: "watcher", id: watcher.id },
        action: { kind: "open-automations", watcherId: watcher.id },
      });
    }
    emitAttentionAll(items);
  } finally {
    inflight.delete(key);
  }
  // A "check now" flagged while this group was in flight was skipped by the
  // inflight guard and its flag survived — honor it with a fresh tick now
  // that the group is free, rather than waiting out the next interval.
  if (watchers.some((watcher) => queuedPolls.has(watcher.id))) {
    void tick(hooks);
  }
}

/** Emit succeeded — apply the watcher's action mode once per new event. The
 * cooldown check runs inside the updater so a burst of fresh events in one
 * poll can only stamp `lastRunAt` — and therefore run — once. */
function dispatchEvent(
  watcher: Watcher,
  item: AttentionItem,
  hooks: WatcherEngineHooks,
  now: number,
) {
  if (watcher.mode === "draft" && hooks.prepareDraft) {
    // The updater also detects a watcher deleted between poll and dispatch —
    // a draft must not open for a watcher that no longer exists.
    let present = false;
    updateWatcher(watcher.id, (row) => {
      present = true;
      return {
        ...row,
        history: watcherHistory(row, { kind: "run", text: `Prepared draft · ${item.title}` }, now),
      };
    });
    if (!present) return;
    try {
      hooks.prepareDraft(watcher, item);
    } catch {
      /* draft prep is best-effort — the row stands either way */
    }
    return;
  }
  if (watcher.mode !== "run" || !hooks.runAction || !watcher.actionId) return;
  // `skipped` doubles as the removed-watcher guard — the updater never ran.
  let skipped = true;
  updateWatcher(watcher.id, (row) => {
    if (row.lastRunAt && now - row.lastRunAt < row.cooldownSec * 1000) {
      return {
        ...row,
        history: watcherHistory(
          row,
          { kind: "skip", text: `Cooldown — skipped run for ${item.title}` },
          now,
        ),
      };
    }
    skipped = false;
    return {
      ...row,
      lastRunAt: now,
      history: watcherHistory(row, { kind: "run", text: `Ran action · ${item.title}` }, now),
    };
  });
  if (skipped) return;
  void hooks
    .runAction(watcher, item)
    .then((outcome) => {
      if (!outcome) return;
      updateWatcher(watcher.id, (row) => ({
        ...row,
        history: watcherHistory(
          row,
          outcome.skipped
            ? { kind: "skip", text: outcome.skipped }
            : { kind: "error", text: outcome.error ?? "Run failed" },
          Date.now(),
        ),
      }));
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
  // Share one provider read per repo/source — group by poll key.
  const groups = new Map<string, Watcher[]>();
  for (const watcher of due) {
    const key = watcherPollKey(watcher);
    groups.set(key, [...(groups.get(key) ?? []), watcher]);
  }
  // Bound concurrent provider work globally — never more than two groups in
  // flight in total, so an event-driven tick can't stack on an interval
  // tick. Groups left over stay due and retry on a later tick.
  const pending = [...groups.values()];
  while (pending.length) {
    const slots = Math.max(0, 2 - inflight.size);
    if (!slots) break;
    await Promise.all(
      pending.splice(0, slots).map((group) => runPollGroup(group, hooks)),
    );
  }
}
