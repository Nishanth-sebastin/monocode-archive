import { useMemo, useSyncExternalStore } from "react";
import { ask } from "@tauri-apps/plugin-dialog";
import {
  loadWatchers,
  openWatchSheet,
  removeWatcher,
  setWatcherEnabled,
  subscribeWatchers,
  watcherSourceLabel,
  watchersSnapshot,
  type Watcher,
} from "../lib/watchers";
import { pollWatcherNow, watcherDueLabel } from "../lib/watcherEngine";
import { formatRelativeTime } from "../lib/githubTasks";

const button =
  "rounded-md border border-content/15 px-2 py-1 text-[12px] text-content/70 hover:bg-content/10 hover:text-content disabled:opacity-40";

const MODE_LABEL = { notify: "Notify", draft: "Draft", run: "Run" } as const;

/**
 * Settings → Automations (#23, #76). Watchers poll while MonoCode is open —
 * this page is their pause/resume, cadence, and run-history surface. The rows
 * they emit land in the rail's Attention queue.
 */
export function AutomationsPage() {
  const raw = useSyncExternalStore(subscribeWatchers, watchersSnapshot);
  const watchers = useMemo(() => (raw ? loadWatchers() : []), [raw]);

  const remove = async (watcher: Watcher) => {
    if (
      await ask(`Stop watching "${watcher.name}"? Its queue rows stay until they resolve.`, {
        title: "Remove watcher",
        kind: "warning",
        okLabel: "Remove",
        cancelLabel: "Cancel",
      })
    )
      removeWatcher(watcher.id);
  };

  return (
    <div className="space-y-4">
      <p className="text-[13px] text-content/60">
        Watchers poll their bound source while MonoCode is open and raise rows
        in the Attention queue. Create them from the place they watch — an
        Inbox query, a pull request, a pipeline.
      </p>
      {watchers.length === 0 ? (
        <p className="rounded-lg border border-dashed border-content/15 px-4 py-6 text-center text-[13px] text-content/45">
          No watchers yet. Use "Watch this query" in the Inbox or "Watch" on a
          PR or pipeline.
        </p>
      ) : (
        <ul className="space-y-2">
          {watchers.map((watcher) => (
            <li
              key={watcher.id}
              className="rounded-lg border border-content/10 px-3 py-2.5"
            >
              <div className="flex items-center gap-2">
                <span className="min-w-0 flex-1 truncate text-[13px] font-medium">
                  {watcher.name}
                </span>
                <span className="shrink-0 rounded bg-content/10 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-content/50">
                  {MODE_LABEL[watcher.mode]}
                </span>
                <span className="shrink-0 text-[11px] text-content/40">
                  {watcherDueLabel(watcher)}
                </span>
              </div>
              <p className="mt-0.5 truncate text-[12px] text-content/50">
                {watcherSourceLabel(watcher.source)}
              </p>
              {watcher.lastError ? (
                <p role="status" className="mt-1 text-[12px] text-red-400">
                  {watcher.lastError}
                </p>
              ) : null}
              {watcher.history.length ? (
                <ul className="mt-1.5 space-y-0.5">
                  {watcher.history.slice(-3).map((entry, index) => (
                    <li
                      key={`${entry.at}-${index}`}
                      className="flex items-baseline gap-2 text-[11px] text-content/45"
                    >
                      <span className="w-10 shrink-0 text-right tabular-nums">
                        {formatRelativeTime(new Date(entry.at).toISOString())}
                      </span>
                      <span
                        className={`shrink-0 ${
                          entry.kind === "error"
                            ? "text-red-400"
                            : entry.kind === "skip"
                              ? "text-content/35"
                              : ""
                        }`}
                      >
                        {entry.kind}
                      </span>
                      <span className="min-w-0 truncate">{entry.text}</span>
                    </li>
                  ))}
                </ul>
              ) : null}
              <div className="mt-2 flex gap-1.5">
                <button
                  type="button"
                  className={button}
                  onClick={() =>
                    setWatcherEnabled(watcher.id, !watcher.enabled)
                  }
                >
                  {watcher.enabled ? "Pause" : "Resume"}
                </button>
                <button
                  type="button"
                  className={button}
                  disabled={!watcher.enabled}
                  onClick={() => pollWatcherNow(watcher.id)}
                >
                  Check now
                </button>
                <button
                  type="button"
                  className={button}
                  onClick={() =>
                    openWatchSheet({
                      source: watcher.source,
                      name: watcher.name,
                      existing: watcher,
                    })
                  }
                >
                  Edit
                </button>
                <button
                  type="button"
                  className={`${button} text-red-400/80 hover:text-red-400`}
                  onClick={() => void remove(watcher)}
                >
                  Remove
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
