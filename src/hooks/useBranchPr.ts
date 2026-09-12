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
  /** Branch the last completed fetch ran under — a checkout that moved on
   * must not serve the old branch's PR to badge readers. */
  branch: string | null;
  /** Newest requested branch — labels the next fetch, even one queued
   * mid-flight by a branch switch. */
  requestedBranch: string | null;
  inFlight: boolean;
  pending: boolean;
  listeners: Set<() => void>;
};

const entries = new Map<string, Entry>();

/** Bumped on every publish so peek-based aggregates can re-derive. */
let version = 0;
const versionListeners = new Set<() => void>();

export function subscribeBranchPrVersion(listener: () => void) {
  versionListeners.add(listener);
  return () => {
    versionListeners.delete(listener);
  };
}

export function branchPrVersion(): number {
  return version;
}

function entryFor(cwd: string): Entry {
  const key = pathKey(cwd);
  let entry = entries.get(key);
  if (!entry) {
    entry = {
      pr: null,
      branch: null,
      requestedBranch: null,
      inFlight: false,
      pending: false,
      listeners: new Set(),
    };
    entries.set(key, entry);
  }
  return entry;
}

function publish(entry: Entry, pr: GitPr | null) {
  entry.pr = pr;
  version += 1;
  for (const listener of entry.listeners) listener();
  for (const listener of versionListeners) listener();
}

function load(
  cwd: string,
  entry: Entry,
  branch: string,
  queueWhenBusy: boolean,
) {
  entry.requestedBranch = branch;
  if (entry.inFlight) {
    if (queueWhenBusy) entry.pending = true;
    return;
  }
  entry.inFlight = true;
  void (async () => {
    try {
      do {
        entry.pending = false;
        // Read at fetch time so a result is labelled with the branch its
        // request ran under, not a later caller's.
        const fetchBranch = entry.requestedBranch;
        try {
          const pr = await gitPrStatus(cwd);
          entry.branch = fetchBranch;
          publish(entry, pr);
        } catch {
          entry.branch = fetchBranch;
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

function snapshot(
  cwd: string,
  branch: string | null | undefined,
): GitPr | null {
  if (!branch) return null;
  const entry = entries.get(pathKey(cwd));
  return entry?.branch === branch ? (entry.pr ?? null) : null;
}

/** Last fetched PR for a checkout — never fetches. For badge/aggregate rows. */
export function cachedBranchPr(
  cwd: string,
  branch: string | null | undefined,
): GitPr | null {
  return usable(cwd, branch) ? snapshot(cwd, branch) : null;
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
    useCallback(
      () => (active ? snapshot(cwd, branch) : null),
      [active, cwd, branch],
    ),
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
    if (active && branch) load(cwd, entryFor(cwd), branch, true);
  }, [active, branch, cwd]);

  useEffect(() => {
    if (!active || !branch) return;
    const entry = entryFor(cwd);
    // Queued, not dropped — an in-flight fetch started under a different
    // branch must not leave its result labelled fresh for this one.
    load(cwd, entry, branch, true);
    const onResume = () => load(cwd, entry, branch, true);
    window.addEventListener("focus", onResume);
    return () => window.removeEventListener("focus", onResume);
  }, [active, branch, cwd]);

  return { pr, reload };
}
