/**
 * Greppable per-turn stage timings in devtools:
 * `[turn abcd1234] stage +12ms (total 345ms)`.
 *
 * Marks are keyed by session id so App, the registry, and harness adapters
 * share one timeline without threading a timer through every call. No-ops
 * once the turn settles or when no turn is being timed.
 */

export type TurnClock = {
  t0: number;
  last: number;
  harness: string;
  firstEvent: boolean;
};

const turns = new Map<string, TurnClock>();

/**
 * Start a clock for a turn. The returned token identifies this clock — pass
 * it to `endTurnTiming` so a slow-finishing superseded turn cannot delete a
 * newer turn's clock.
 */
export function beginTurnTiming(
  sessionId: string,
  harness: string,
): TurnClock {
  const now = performance.now();
  const clock: TurnClock = {
    t0: now,
    last: now,
    harness,
    firstEvent: false,
  };
  turns.set(sessionId, clock);
  return clock;
}

export function markTurn(sessionId: string, stage: string): void {
  const turn = turns.get(sessionId);
  if (!turn) return;
  const now = performance.now();
  console.debug(
    `[turn ${turn.harness} ${sessionId.slice(0, 8)}] ${stage} ` +
      `+${(now - turn.last).toFixed(0)}ms (total ${(now - turn.t0).toFixed(0)}ms)`,
  );
  turn.last = now;
}

/** First provider event the user could see — the latency that matters. */
export function markFirstTurnEvent(sessionId: string): void {
  const turn = turns.get(sessionId);
  if (!turn || turn.firstEvent) return;
  turn.firstEvent = true;
  markTurn(sessionId, "first event");
}

export function endTurnTiming(
  sessionId: string,
  outcome = "settled",
  clock?: TurnClock,
): void {
  // A superseded turn's finally must not wipe a newer turn's clock.
  if (clock && turns.get(sessionId) !== clock) return;
  markTurn(sessionId, outcome);
  turns.delete(sessionId);
}
