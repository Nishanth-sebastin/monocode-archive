import {
  allAzurePrAssociations,
  type AzurePrAssociation,
} from "./azureRepos";
import {
  allCiSources,
  ciMatches,
  ciState,
  type CiSource,
} from "./azurePipelines";
import type { GitPr } from "./fs";
import type { TaskChild, TaskWorkspace } from "./taskWorkspaces";

/**
 * Compact delivery state for one task child — counts and attention flags only,
 * never provider payloads. Derived from saved provider links plus whatever
 * fresh data the caller already holds; this module never fetches.
 */
export type TaskChildDelivery = {
  /** Linked pull requests still open/active, across providers. */
  prs: number;
  /** A linked PR is waiting on the author (Azure reviewer vote < 0). */
  prNeedsAttention: boolean;
  /** Linked CI pipelines for this checkout. */
  ci: number;
  /** A linked pipeline's latest verified run is queued/running. */
  ciRunning: boolean;
  /** A linked pipeline's latest verified run failed. */
  ciFailing: boolean;
};

export const EMPTY_DELIVERY: TaskChildDelivery = {
  prs: 0,
  prNeedsAttention: false,
  ci: 0,
  ciRunning: false,
  ciFailing: false,
};

const shortRef = (ref: string) => ref.replace(/^refs\/heads\//, "");

/** Saved provider links, parsed once — pass to every childDelivery call in a
 * loop so an N-child task costs one storage read, not N. */
export type DeliveryStores = {
  prs: AzurePrAssociation[];
  ci: CiSource[];
};

export function deliveryStores(): DeliveryStores {
  return { prs: allAzurePrAssociations(), ci: allCiSources() };
}

function taskSessionIds(task: TaskWorkspace): Set<string> {
  const ids = new Set(task.sessionIds);
  for (const child of task.children)
    for (const id of child.sessionIds) ids.add(id);
  return ids;
}

/**
 * Delivery links saved against one child checkout.
 *
 * `branches` are the names this child may be known under (the recorded
 * `child.branch` plus the observed head from diff stats/index). A saved link
 * counts when its scope session belongs to this task (or is unassigned) and
 * its own branch — or the PR's source ref — names a known branch, so a
 * checkout that moved on does not silently inherit a stale link. With no
 * known branch the child's links stay unknown rather than guessed.
 */
export function childDelivery(
  task: TaskWorkspace,
  child: TaskChild,
  branches: readonly (string | null | undefined)[],
  githubPr?: GitPr | null,
  stores: DeliveryStores = deliveryStores(),
): TaskChildDelivery {
  const delivery = { ...EMPTY_DELIVERY };
  const cwd = child.workingCopy;
  if (!cwd) return delivery;
  const known = new Set(branches.filter((b): b is string => !!b));
  if (!known.size) return delivery;
  const sessions = taskSessionIds(task);
  const scoped = (session: string | undefined) =>
    session === undefined || sessions.has(session);

  for (const row of stores.prs) {
    if (row.cwd !== cwd || !scoped(row.sourceSessionId)) continue;
    if (!known.has(row.branch) && !known.has(shortRef(row.pr.sourceRefName)))
      continue;
    if (row.pr.status.toLowerCase() !== "active") continue;
    delivery.prs += 1;
    if (row.pr.reviewers.some((reviewer) => reviewer.vote < 0))
      delivery.prNeedsAttention = true;
  }
  if (githubPr && githubPr.state.toLowerCase() === "open") delivery.prs += 1;

  for (const row of stores.ci) {
    if (row.cwd !== cwd || !scoped(row.session)) continue;
    if (
      !known.has(row.branch) &&
      !known.has(shortRef(row.last?.run.branch ?? ""))
    )
      continue;
    delivery.ci += 1;
    const run = row.last?.run;
    if (!run || !ciMatches(run)) continue;
    const state = ciState(run.status, run.result);
    if (state === "Failed") delivery.ciFailing = true;
    else if (state === "Queued" || state === "Running" || state === "Cancelling")
      delivery.ciRunning = true;
  }
  return delivery;
}

/**
 * Short status phrases for a whole task, most actionable first — e.g.
 * "1 needs input", "CI failing", "2 working". Empty when nothing is
 * reportable (all children idle/ready). Derived per child so several
 * repositories can each contribute; the caller renders them joined.
 */
export function taskStatusSegments(
  task: TaskWorkspace,
  opts: {
    /** Sessions currently mid-turn (live agents, not done). */
    busySessionIds?: ReadonlySet<string>;
    /** Sessions blocked on approval/question. */
    needsInputIds?: ReadonlySet<string>;
    /** Per-child delivery from childDelivery; omit for session-only state. */
    delivery?: ReadonlyMap<string, TaskChildDelivery>;
  } = {},
): string[] {
  const sessions = taskSessionIds(task);
  const segments: string[] = [];

  const needsInput = [...sessions].filter((id) =>
    opts.needsInputIds?.has(id),
  ).length;
  if (needsInput)
    segments.push(
      needsInput === 1 ? "1 needs input" : `${needsInput} need input`,
    );

  let ciFailing = 0;
  let prAttention = 0;
  let ciRunning = 0;
  for (const child of task.children) {
    const delivery = opts.delivery?.get(child.id);
    if (!delivery) continue;
    if (delivery.ciFailing) ciFailing += 1;
    if (delivery.prNeedsAttention) prAttention += 1;
    if (delivery.ciRunning) ciRunning += 1;
  }
  if (ciFailing)
    segments.push(ciFailing === 1 ? "CI failing" : `CI failing ×${ciFailing}`);
  if (prAttention)
    segments.push(
      prAttention === 1 ? "PR needs review" : `${prAttention} PRs need review`,
    );

  const failed = task.children.filter(
    (child) => child.launch.state === "failed",
  ).length;
  if (failed)
    segments.push(failed === 1 ? "1 failed" : `${failed} failed`);

  const working = [...sessions].filter((id) =>
    opts.busySessionIds?.has(id),
  ).length;
  if (working)
    segments.push(working === 1 ? "1 working" : `${working} working`);
  else if (ciRunning) segments.push("CI running");

  const unprepared = task.children.filter(
    (child) => !child.workingCopy && child.launch.state === "pending",
  ).length;
  if (unprepared)
    segments.push(
      unprepared === 1 ? "1 to prepare" : `${unprepared} to prepare`,
    );

  return segments;
}
