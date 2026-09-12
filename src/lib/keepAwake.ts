import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { sessionNeedsInput, type Session } from "./session";

export type PowerStatus = {
  /** False on platforms without a supported idle-sleep assertion. */
  supported: boolean;
  enabled: boolean;
  /** A verified OS assertion is held right now. */
  held: boolean;
  /** Qualifying sessions across all windows. */
  working: number;
  error: string | null;
  /** False until the first backend status arrives; gates "not available". */
  loaded: boolean;
};

/** Status as the backend emits it; `loaded` is added frontend-side. */
type BackendPowerStatus = Omit<PowerStatus, "loaded">;

const POWER_EVENT = "power-assertion";

const EMPTY_STATUS: PowerStatus = {
  supported: true,
  enabled: false,
  held: false,
  working: 0,
  error: null,
  loaded: false,
};

/**
 * Sessions doing real execution: a live turn that is not parked on an
 * approval or question. Background subagents keep `busy` set, so they are
 * covered; inbox-ask turns count too — they are real agent work. Waiting,
 * queued-only, finished, failed and unknown sessions are not.
 */
export function keepAwakeSessionIds(sessions: Session[]): string[] {
  const ids = new Set<string>();
  for (const session of sessions) {
    if (session.busy && !sessionNeedsInput(session)) ids.add(session.id);
  }
  return [...ids].sort();
}

let lastEnabledPush: boolean | null = null;
let lastIdsKey: string | null = null;

/**
 * Push the shared setting and this window's qualifying set; each runs only
 * when its own value changes. The enabled flag travels on its own command so
 * a window whose localStorage has not converged yet cannot release another
 * window's legitimate hold through a routine ref sync.
 */
export function syncKeepAwake(enabled: boolean, sessionIds: string[]) {
  if (enabled !== lastEnabledPush) {
    lastEnabledPush = enabled;
    void invoke("power_set_enabled", { enabled }).catch(() => {
      lastEnabledPush = null;
    });
  }
  const key = sessionIds.join("\n");
  if (key === lastIdsKey) return;
  lastIdsKey = key;
  void invoke("power_sync", { sessionIds }).catch(() => {
    // A lost push must not wedge the key: the next change sends again.
    lastIdsKey = null;
  });
}

export function retryKeepAwake(): Promise<BackendPowerStatus> {
  // Pipe the fresh status through the store too: the broadcast event does the
  // same thing, but this keeps Retry working even if the listener is dead.
  return invoke<BackendPowerStatus>("power_retry").then((status) => {
    applyStatus(status);
    return status;
  });
}

let statusSnapshot: PowerStatus = EMPTY_STATUS;
const statusListeners = new Set<() => void>();
let statusBridge: Promise<unknown> | null = null;

export function getPowerStatus(): PowerStatus {
  return statusSnapshot;
}

export function subscribePowerStatus(onStoreChange: () => void): () => void {
  statusListeners.add(onStoreChange);
  ensureStatusBridge();
  return () => {
    statusListeners.delete(onStoreChange);
  };
}

function notifyStatus() {
  for (const listener of statusListeners) listener();
}

function applyStatus(status: BackendPowerStatus) {
  statusSnapshot = { ...status, loaded: true };
  notifyStatus();
}

function ensureStatusBridge() {
  if (statusBridge) return;
  // Register the listener before fetching: a status event landing between
  // registration and the fetch resolving must not be overwritten by the
  // older snapshot.
  const bridge = listen<BackendPowerStatus>(POWER_EVENT, (event) => {
    applyStatus(event.payload);
  }).then(() =>
    invoke<BackendPowerStatus>("power_status")
      .then(applyStatus)
      .catch(() => undefined),
  );
  statusBridge = bridge;
  // A failed bridge must not wedge status for the session lifetime; the next
  // subscriber tries again.
  void bridge.catch(() => {
    if (statusBridge === bridge) statusBridge = null;
  });
}
