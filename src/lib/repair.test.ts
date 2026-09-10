// @vitest-environment happy-dom
import { beforeEach, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import {
  ciRepair,
  commentsRepair,
  validateRepair,
  assertRepairOwner,
  reserveRepair,
  repairRecords,
  updateRepair,
  type RepairDelivery,
} from "./repair";
import { newSession } from "./session";
import type { CiSource, CiRun, CiJob, CiLog } from "./azurePipelines";
import type { AzurePrAssociation, AzurePrThread } from "./azureRepos";
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("./harness/registry", () => ({ isLiveHarness: () => true }));
const source: CiSource = {
  target: {
    site: "https://dev.azure.com/org",
    accountId: "account",
    project: "project",
    definition: 7,
    repositoryId: "team/repo",
    repositoryType: "GitHub",
    repositoryUrl: "https://github.com/team/repo",
  },
  cwd: "wsl://Ubuntu/work/repo",
  branch: "feature",
  remote: "https://github.com/team/repo",
  session: "owner",
  projectName: "Project",
  definitionName: "Tests",
};
const head = {
  cwd: source.cwd,
  branch: source.branch,
  commit: "head",
  remote: source.remote,
};
const run: CiRun = {
  id: 8,
  number: "8",
  revision: "run-attempt-2",
  result: "failed",
  status: "completed",
  branch: "refs/heads/feature",
  commit: "head",
  match: "exact",
  queuedAt: "now",
};
const job: CiJob = {
  id: "task",
  name: "Test",
  type: "Task",
  attempt: 2,
  logId: 9,
  state: "completed",
  result: "failed",
};
const log: CiLog = {
  text: "Expected 1, got 2",
  startLine: 1,
  endLine: 2,
  lineCount: 3,
  attempt: 2,
  logId: 9,
  recordId: "task",
  bounded: true,
};
const owner = {
  ...newSession("codex", source.cwd),
  id: "owner",
  providerSessionId: "provider-1",
};
const delivery = (): RepairDelivery => ({
  id: crypto.randomUUID(),
  ...ciRepair(source, head, run, job, log),
  owner: {
    id: owner.id,
    harness: owner.harness,
    model: owner.model,
    cwd: head.cwd,
    runtimeMode: owner.runtimeMode,
    providerSessionId: owner.providerSessionId,
  },
});
beforeEach(() => {
  const store = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => store.set(key, value),
  });
  vi.mocked(invoke)
    .mockReset()
    .mockImplementation(async (command) =>
      command === "azure_ci_context"
        ? { ...head, remotes: [{ name: "origin", url: head.remote }] }
        : log,
    );
});
it("rechecks commit, selected run/log/attempt and rejects changed evidence", async () => {
  const draft = delivery();
  await validateRepair(draft.evidence, draft.context);
  expect(invoke).toHaveBeenLastCalledWith("azure_ci_read", {
    input: expect.objectContaining({
      runId: 8,
      revision: "run-attempt-2",
      recordId: "task",
      attempt: 2,
      logId: 9,
      startLine: 1,
      head,
    }),
  });
  vi.mocked(invoke).mockResolvedValueOnce({
    ...head,
    commit: "new",
    remotes: [{ url: head.remote }],
  });
  await expect(validateRepair(draft.evidence, draft.context)).rejects.toThrow(
    "Checkout changed",
  );
  vi.mocked(invoke).mockImplementation(async (command) =>
    command === "azure_ci_context"
      ? { ...head, remotes: [{ url: head.remote }] }
      : { ...log, text: "Changed failure" },
  );
  await expect(validateRepair(draft.evidence, draft.context)).rejects.toThrow(
    "Log evidence changed",
  );
});
it("rejects a different checkout, owner, provider identity, or an existing draft", () => {
  const draft = delivery();
  expect(() => assertRepairOwner(draft, owner)).not.toThrow();
  for (const changed of [
    { ...owner, id: "focused-other" },
    { ...owner, worktreeCwd: "/other" },
    { ...owner, providerSessionId: "provider-2" },
    { ...owner, composerSeed: "unsent draft" },
    undefined,
  ])
    expect(() => assertRepairOwner(draft, changed)).toThrow();
  expect(() =>
    ciRepair(source, head, { ...run, match: "old-commit" }, job, log),
  ).toThrow();
});
it("rejects duplicate, overlapping and uncertain repairs until explicit reconciliation", () => {
  const draft = delivery();
  reserveRepair(draft);
  expect(() =>
    reserveRepair({ ...delivery(), owner: { ...draft.owner, id: "another" } }),
  ).toThrow("already exists");
  updateRepair(draft.id, "uncertain", "Interrupted");
  expect(() => reserveRepair(delivery())).toThrow("already exists");
  updateRepair(draft.id, "released", "User checked conversation");
  const next = delivery();
  reserveRepair(next);
  expect(repairRecords().find((row) => row.id === next.id)?.session).toBe(
    "owner",
  );
  updateRepair(next.id, "blocked", "Not dispatched");
});
it("verifies selected unresolved comments as well as PR revision", async () => {
  const association: AzurePrAssociation = {
    cwd: source.cwd,
    branch: "feature",
    sourceSessionId: "owner",
    target: {
      site: source.target.site,
      accountId: "account",
      project: "project-id",
      repository: "repo-id",
      number: 9,
    },
    account: "Ada",
    projectName: "Project",
    repositoryName: "Repo",
    revision: "pr-head-target",
    pr: {
      pullRequestId: 9,
      title: "Work",
      status: "active",
      sourceRefName: "refs/heads/feature",
      targetRefName: "refs/heads/main",
      lastMergeSourceCommit: { commitId: "head" },
      reviewers: [],
    },
  };
  const threads: AzurePrThread[] = [
    {
      id: 1,
      status: "active",
      comments: [{ id: 3, content: "Handle failure" }],
    },
    { id: 2, status: "fixed", comments: [] },
  ];
  let changed = false;
  vi.mocked(invoke).mockImplementation(async (command, args) =>
    command === "azure_ci_context"
      ? {
          ...head,
          remotes: [{ url: "https://dev.azure.com/org/project/_git/repo" }],
        }
      : (args as { section: string }).section === "summary"
        ? { pr: association.pr, revision: association.revision }
        : {
            items: changed ? [{ ...threads[0], status: "fixed" }] : threads,
            revision: association.revision,
            nextSkip: null,
          },
  );
  const draft = await commentsRepair(association, threads, 50);
  expect(draft.context.entries).toHaveLength(1);
  await validateRepair(draft.evidence, draft.context);
  expect(invoke).toHaveBeenLastCalledWith(
    "azure_pr_read",
    expect.objectContaining({
      section: "threads",
      skip: 50,
      expectedRevision: "pr-head-target",
    }),
  );
  changed = true;
  await expect(validateRepair(draft.evidence, draft.context)).rejects.toThrow(
    "Selected comments changed",
  );
});

it("does not reserve a second scope while its destination is being checked", () => {
  const draft = delivery();
  draft.evidence.scope = "another-pipeline";
  expect(() => reserveRepair(draft, true)).toThrow(
    "Another repair is checking",
  );
  expect(repairRecords().some((row) => row.id === draft.id)).toBe(false);
});
