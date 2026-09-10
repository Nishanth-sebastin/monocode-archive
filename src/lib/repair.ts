import { boundAgentContext, type AgentContext } from "./agentContext";
import {
  azurePrContext,
  azurePrKey,
  readAzurePr,
  readAzurePrSection,
  type AzurePrAssociation,
  type AzurePrThread,
} from "./azureRepos";
import {
  ciContext,
  ciKey,
  ciLogContext,
  ciMatches,
  ciRead,
  type CiHead,
  type CiSource,
  type CiRun,
  type CiJob,
  type CiLog,
} from "./azurePipelines";
import { sessionWorkCwd, type Session } from "./session";
import { isLiveHarness } from "./harness/registry";
import { isPreparingHandoff } from "./handoff";

export type RepairEvidence = {
  scope: string;
  head: CiHead;
} & (
  | {
      kind: "comments";
      association: AzurePrAssociation;
      skip: number;
      threads: { id: number; digest: string; entry: string }[];
    }
  | {
      kind: "ci";
      source: CiSource;
      run: CiRun;
      job: CiJob;
      log: Pick<
        CiLog,
        "startLine" | "endLine" | "attempt" | "logId" | "recordId"
      >;
    }
);
export type RepairDelivery = {
  id: string;
  evidence: RepairEvidence;
  context: AgentContext;
  owner: {
    id: string;
    harness: Session["harness"];
    model: string;
    cwd: string;
    runtimeMode: Session["runtimeMode"];
    providerSessionId?: string;
  };
};
export type RepairRecord = {
  id: string;
  scope: string;
  cwd: string;
  commit: string;
  session: string;
  state:
    | "checking"
    | "queued"
    | "running"
    | "completed"
    | "blocked"
    | "uncertain"
    | "released";
  detail: string;
  at: number;
};
export const REPAIR_CHANGE = "monocode:repair-change";
export const OPEN_REPAIR = "monocode:open-repair";
const KEY = "monocode.repairs.v1";
let records: RepairRecord[] | undefined;
export function repairRecords(): RepairRecord[] {
  if (!records) {
    const value = JSON.parse(
      localStorage.getItem(KEY) || "[]",
    ) as RepairRecord[];
    if (
      !Array.isArray(value) ||
      value.length > 100 ||
      value.some((row) => !row.id || !row.scope || !row.session || !row.cwd)
    )
      throw new Error(
        "Repair recovery records are unreadable. Restore local app data before sending another repair.",
      );
    records = value.map((row) =>
      ["checking", "queued", "running"].includes(row.state)
        ? {
            ...row,
            state: "uncertain",
            detail:
              "App interrupted. Inspect the conversation before allowing another request.",
          }
        : row,
    );
  }
  return records;
}
function save(next: RepairRecord[]) {
  localStorage.setItem(KEY, JSON.stringify(next)); // Failure must prevent dispatch, not silently lose deduplication.
  records = next;
  window.dispatchEvent(new Event(REPAIR_CHANGE));
}
export function reserveRepair(delivery: RepairDelivery, checkingOwner = false) {
  if (checkingOwner)
    throw new Error(
      "Another repair is checking this agent. Wait before trying again.",
    );
  const rows = repairRecords();
  const { evidence: e, owner } = delivery;
  // One active repair per artifact and checkout, including overlapping thread/job selections.
  if (
    rows.some(
      (row) =>
        row.scope === e.scope &&
        row.cwd === e.head.cwd &&
        !["released", "blocked"].includes(row.state),
    )
  )
    throw new Error(
      "A repair already exists for this work. Open its conversation and reconcile it before trying again.",
    );
  const retained = rows.filter(
    (row) => !["released", "blocked"].includes(row.state),
  ).length;
  if (retained >= 100)
    throw new Error(
      "Repair history is full. Reconcile completed requests before starting another.",
    );
  const next = [
    ...rows,
    {
      id: delivery.id,
      scope: e.scope,
      cwd: e.head.cwd,
      commit: e.head.commit,
      session: owner.id,
      state: "checking" as const,
      detail: "Checking selected evidence",
      at: Date.now(),
    },
  ];
  while (next.length > 100)
    next.splice(
      next.findIndex((row) => ["released", "blocked"].includes(row.state)),
      1,
    );
  save(next);
}
export function updateRepair(
  id: string,
  state: RepairRecord["state"],
  detail: string,
) {
  save(
    repairRecords().map((row) =>
      row.id === id
        ? { ...row, state, detail: detail.slice(0, 1000), at: Date.now() }
        : row,
    ),
  );
}
export function repairOwnerError(
  session: Session | undefined,
  evidence: RepairEvidence,
) {
  if (
    !session ||
    session.inboxAsk ||
    sessionWorkCwd(session) !== evidence.head.cwd
  )
    return "Choose an agent bound to this exact checkout.";
  if (!isLiveHarness(session.harness))
    return "This agent provider is not connected.";
  if (session.pendingSwitch || isPreparingHandoff(session))
    return "Finish the agent handoff before starting repair.";
  if (
    session.contextDraft ||
    session.noteCard ||
    session.handoffCard ||
    session.composerSeed?.trim()
  )
    return "Send or clear the destination's existing draft first.";
  return "";
}
export function assertRepairOwner(
  delivery: RepairDelivery,
  session: Session | undefined,
) {
  const error = repairOwnerError(session, delivery.evidence);
  const owner = delivery.owner;
  if (
    error ||
    !session ||
    session.id !== owner.id ||
    session.harness !== owner.harness ||
    session.model !== owner.model ||
    session.runtimeMode !== owner.runtimeMode ||
    session.providerSessionId !== owner.providerSessionId
  )
    throw new Error(
      error ||
        "Agent ownership changed. Open the evidence and choose the destination again.",
    );
}
async function digest(value: unknown) {
  const bytes = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(JSON.stringify(value)),
  );
  return Array.from(new Uint8Array(bytes), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
}
export const unresolvedThread = (thread: AzurePrThread) =>
  !thread.isDeleted && ["active", "pending"].includes(thread.status);
export async function commentsRepair(
  association: AzurePrAssociation,
  threads: AzurePrThread[],
  skip: number,
) {
  const selected = threads.filter(unresolvedThread).slice(0, 20);
  if (!selected.length) throw new Error("Load unresolved comments first.");
  const checkout = await ciContext(association.cwd);
  const remote =
    `${association.target.site}/${encodeURIComponent(association.projectName)}/_git/${encodeURIComponent(association.repositoryName)}`.toLowerCase();
  if (
    !checkout.remotes.some((row) => row.url === remote) ||
    checkout.branch !== association.branch ||
    checkout.commit !== association.pr.lastMergeSourceCommit?.commitId ||
    association.pr.sourceRefName !== `refs/heads/${checkout.branch}`
  )
    throw new Error(
      "The checkout must match this PR repository, source branch and head before repair.",
    );
  const entries = selected.map(
    (thread) => azurePrContext(association, thread).entries[0],
  );
  const evidence: RepairEvidence = {
    kind: "comments",
    scope: azurePrKey(association.target),
    head: {
      cwd: checkout.cwd,
      branch: checkout.branch,
      commit: checkout.commit,
      remote,
    },
    association,
    skip,
    threads: await Promise.all(
      selected.map(async (thread, i) => ({
        id: thread.id,
        digest: await digest(thread),
        entry: entries[i].id,
      })),
    ),
  };
  return {
    evidence,
    context: boundAgentContext({
      id: crypto.randomUUID(),
      entries,
      attachments: [],
      instruction:
        "Address the selected unresolved review comments in this checkout. Run relevant checks and summarize changes. Do not reply, resolve threads, push or merge.",
    }),
  };
}
export function ciRepair(
  source: CiSource,
  head: CiHead,
  run: CiRun,
  job: CiJob,
  log: CiLog,
) {
  if (!ciMatches(run) || run.result !== "failed" || job.result !== "failed")
    throw new Error(
      "Choose a failed job from a failed run verified for this checkout commit.",
    );
  const context = ciLogContext(source, head, run, job, log);
  context.instruction =
    "Fix the selected CI failure in this checkout. Run relevant checks and summarize changes. Do not rerun pipelines, push or merge.";
  return {
    evidence: {
      kind: "ci",
      scope: ciKey(source.target),
      head,
      source,
      run,
      job,
      log: {
        startLine: log.startLine,
        endLine: log.endLine,
        attempt: log.attempt,
        logId: log.logId,
        recordId: log.recordId,
      },
    } as RepairEvidence,
    context,
  };
}
export async function validateRepair(
  evidence: RepairEvidence,
  context: AgentContext,
) {
  if (!context.entries.length || !context.instruction?.trim())
    throw new Error("Select evidence and enter a repair instruction.");
  const checkout = await ciContext(evidence.head.cwd);
  if (
    checkout.commit !== evidence.head.commit ||
    checkout.branch !== evidence.head.branch ||
    !checkout.remotes.some((row) => row.url === evidence.head.remote)
  )
    throw new Error("Checkout changed. Close this draft and Refresh evidence.");
  if (evidence.kind === "ci") {
    const log = await ciRead<CiLog>(
      evidence.source.target,
      evidence.head,
      evidence.run,
      "log",
      {
        recordId: evidence.job.id,
        attempt: evidence.log.attempt,
        logId: evidence.log.logId,
        startLine: evidence.log.startLine,
      },
    );
    const fresh = ciLogContext(
      evidence.source,
      evidence.head,
      evidence.run,
      evidence.job,
      log,
    );
    if (fresh.entries[0].text !== context.entries[0]?.text)
      throw new Error(
        "Log evidence changed. Close this draft and Refresh evidence.",
      );
  } else {
    const pr = await readAzurePr(
      evidence.association.target,
      evidence.association.revision,
    );
    if (pr.pr.status !== "active")
      throw new Error("PR is no longer active. Refresh evidence.");
    const page = await readAzurePrSection<AzurePrThread>(
      evidence.association.target,
      evidence.association.revision,
      "threads",
      evidence.skip,
    );
    for (const selected of evidence.threads.filter((row) =>
      context.entries.some((entry) => entry.id === row.entry),
    )) {
      const thread = page.items.find((row) => row.id === selected.id);
      if (
        !thread ||
        !unresolvedThread(thread) ||
        (await digest(thread)) !== selected.digest
      )
        throw new Error(
          "Selected comments changed. Close this draft and Refresh evidence.",
        );
    }
  }
}
