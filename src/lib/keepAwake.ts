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
  error?: string;
};

const POWER_EVENT = "power-assertion";

const EMPTY_STATUS: PowerStatus = {
  supported: true,
  enabled: false,
  held: false,
  working: 0,
};

/**
 * Sessions doing real execution: a live turn that is not parked on an
 * approval or question. Background subagents keep `busy` set, so they are
 * covered; waiting, queued-only, finished, failed and unknown sessions are not.
 */
export function keepAwakeSessionIds(sessions: Session[]): string[] {
  const ids = new Set<string>();
  for (const session of sessions) {
    if (session.busy && !sessionNeedsInput(session)) ids.add(session.id);
  }
  return [...ids].sort();
}

let lastSyncKey: string | null = null;

/** Push this window's qualifying set; runs only on membership/flag changes. */
export function syncKeepAwake(enabled: boolean, sessionIds: string[]) {
  const key = `${enabled ? "1" : "0"}${sessionIds.join(",")}`;
  if (key === lastSyncKey) return;
  lastSyncKey = key;
  void invoke("power_sync", { enabled, sessionIds }).catch(() => {
    // A lost push must not wedge the key: the next change sends again.
    lastSyncKey = null;
  });
}

export function retryKeepAwake(): Promise<PowerStatus> {
  return invoke<PowerStatus>("power_retry");
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

function ensureStatusBridge() {
  if (statusBridge) return;
  statusBridge = Promise.all([
    listen<PowerStatus>(POWER_EVENT, (event) => {
      statusSnapshot = event.payload;
      notifyStatus();
    }),
    invoke<PowerStatus>("power_status")
      .then((status) => {
        statusSnapshot = status;
        notifyStatus();
      })
      .catch(() => undefined),
  ]).catch(() => undefined);
}
