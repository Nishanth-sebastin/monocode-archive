import { useCallback, useEffect, useSyncExternalStore } from "react";
import { gitPrStatus, type GitPr } from "../lib/fs";
import { pathKey } from "../lib/paths";

/**
 * Shared, per-checkout GitHub PR cache. Fetching is deduplicated across
 * subscribers and refreshed on window focus; readers that only need the last
 * known value (badges, task aggregates) subscribe without triggering a fetch.
 */

type Entry = {
  pr: GitPr | null;
  inFlight: boolean;
  pending: boolean;
  listeners: Set<() => void>;
};

const entries = new Map<string, Entry>();

function entryFor(cwd: string): Entry {
  const key = pathKey(cwd);
  let entry = entries.get(key);
  if (!entry) {
    entry = { pr: null, inFlight: false, pending: false, listeners: new Set() };
    entries.set(key, entry);
  }
  return entry;
}

function publish(entry: Entry, pr: GitPr | null) {
  entry.pr = pr;
  for (const listener of entry.listeners) listener();
}

function load(cwd: string, entry: Entry, queueWhenBusy: boolean) {
  if (entry.inFlight) {
    if (queueWhenBusy) entry.pending = true;
    return;
  }
  entry.inFlight = true;
  void (async () => {
    try {
      do {
        entry.pending = false;
        try {
          publish(entry, await gitPrStatus(cwd));
        } catch {
          publish(entry, null);
        }
      } while (entry.pending);
    } finally {
      entry.inFlight = false;
    }
  })();
}

const usable = (cwd: string, branch: string | null | undefined) =>
  !!cwd && cwd !== "~" && !!branch;

function subscribe(cwd: string) {
  return (listener: () => void) => {
    const entry = entryFor(cwd);
    entry.listeners.add(listener);
    return () => {
      entry.listeners.delete(listener);
    };
  };
}

function snapshot(cwd: string): GitPr | null {
  return entries.get(pathKey(cwd))?.pr ?? null;
}

/** Last fetched PR for a checkout — never fetches. For badge/aggregate rows. */
export function cachedBranchPr(
  cwd: string,
  branch: string | null | undefined,
): GitPr | null {
  return usable(cwd, branch) ? snapshot(cwd) : null;
}

/** Subscribed read of the shared cache — still never fetches. */
export function useCachedBranchPr(
  cwd: string,
  branch: string | null | undefined,
): GitPr | null {
  const active = usable(cwd, branch);
  return useSyncExternalStore(
    useCallback(
      (listener) => (active ? subscribe(cwd)(listener) : () => {}),
      [active, cwd],
    ),
    useCallback(() => (active ? snapshot(cwd) : null), [active, cwd]),
  );
}

/** Fetching read: loads on mount and on window focus, deduplicated per cwd. */
export function useBranchPr(
  cwd: string,
  branch: string | null | undefined,
): { pr: GitPr | null; reload: () => void } {
  const active = usable(cwd, branch);
  const pr = useCachedBranchPr(cwd, branch);
  const reload = useCallback(() => {
    if (active) load(cwd, entryFor(cwd), true);
  }, [active, cwd]);

  useEffect(() => {
    if (!active) return;
    const entry = entryFor(cwd);
    load(cwd, entry, false);
    const onResume = () => load(cwd, entry, true);
    window.addEventListener("focus", onResume);
    return () => window.removeEventListener("focus", onResume);
  }, [active, branch, cwd]);

  return { pr, reload };
}
