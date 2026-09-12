// @vitest-environment happy-dom
import { expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { ask, message } from "@tauri-apps/plugin-dialog";
import {
  abortMerge,
  sendMergeConflictsToAgent,
  syncConfirmText,
  syncWithDefaultBranch,
} from "./syncDefault";
import { requestAgentContext } from "./agentContext";
import type { GitDiffIndex } from "./fs";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({
  ask: vi.fn(async () => true),
  message: vi.fn(async () => undefined),
}));
vi.mock("./agentContext", async (original) => ({
  ...(await original<typeof import("./agentContext")>()),
  requestAgentContext: vi.fn(),
}));

const cleanIndex: GitDiffIndex = {
  branch: "feature",
  files: [],
  additions: 0,
  deletions: 0,
  remote: "origin",
  upstream: null,
  defaultBranch: "main",
  ahead: 0,
  behind: 0,
  aheadOfDefault: 0,
  opInProgress: false,
  conflicts: [],
  mergeHead: null,
};

function mockInvoke(
  handler: (command: string, args?: unknown) => unknown,
) {
  vi.mocked(invoke).mockImplementation(async (command, args) =>
    handler(command, args),
  );
}

it("names fetch, merge, the exact refs, working copy and host in the confirm", () => {
  const text = syncConfirmText("/repo/wt", {
    ...cleanIndex,
    branch: "feat/x",
  });
  expect(text).toContain("merge origin/main into feat/x");
  expect(text).toContain("/repo/wt");
  expect(text).toContain("Fetch origin");
});

it("reports a WSL host instead of the native platform", () => {
  const text = syncConfirmText("//wsl.localhost/Ubuntu/home/me/repo", {
    ...cleanIndex,
    defaultBranch: "master",
  });
  expect(text).toContain("origin/master");
  expect(text).toContain("WSL · Ubuntu");
  expect(text).not.toContain("macOS");
});

it("runs fetch+merge after confirmation and reports merged commits", async () => {
  const asks: string[] = [];
  vi.mocked(ask).mockImplementation(async (text) => {
    asks.push(String(text));
    return true;
  });
  mockInvoke((command) => {
    if (command === "git_diff_index") return cleanIndex;
    if (command === "git_sync_branch")
      return {
        outcome: "merged",
        branch: "feature",
        syncedWith: "origin/main",
        commits: ["remote work"],
        conflicts: [],
        reason: "",
      };
    return null;
  });
  const result = await syncWithDefaultBranch({ cwd: "/repo" });
  expect(result?.outcome).toBe("merged");
  expect(asks[0]).toContain("merge origin/main into feature");
  expect(vi.mocked(message).mock.calls.at(-1)?.[0]).toContain("remote work");
});

it("never runs the sync when the user declines the confirmation", async () => {
  vi.mocked(invoke).mockClear();
  vi.mocked(ask).mockResolvedValueOnce(false);
  mockInvoke((command) =>
    command === "git_diff_index" ? cleanIndex : null,
  );
  const result = await syncWithDefaultBranch({ cwd: "repo" });
  expect(result).toBeUndefined();
  expect(
    vi.mocked(invoke).mock.calls.some(([c]) => c === "git_sync_branch"),
  ).toBe(false);
});

it("surfaces a refused sync as a warning, not an error throw", async () => {
  vi.mocked(ask).mockResolvedValue(true);
  mockInvoke((command) => {
    if (command === "git_diff_index") return cleanIndex;
    if (command === "git_sync_branch")
      return {
        outcome: "refused",
        branch: "",
        syncedWith: "",
        commits: [],
        conflicts: [],
        reason: "3 uncommitted changes. Commit or stash before syncing — nothing is stashed automatically.",
      };
    return null;
  });
  const result = await syncWithDefaultBranch({ cwd: "/repo" });
  expect(result?.outcome).toBe("refused");
  expect(vi.mocked(message).mock.calls.at(-1)?.[0]).toContain(
    "uncommitted changes",
  );
});

it("sends live merge state — host, cwd, branch, incoming ref, paths, bounded diff — to the owning session", async () => {
  mockInvoke((command) => {
    if (command === "git_merge_context")
      return {
        merging: true,
        conflicts: ["src/app.ts"],
        mergeHead: "abc1234",
        diff: "<<<<<<< HEAD\nours\n=======\ntheirs\n>>>>>>> FETCH_HEAD",
      };
    if (command === "git_diff_index") return cleanIndex;
    return null;
  });
  const sent = await sendMergeConflictsToAgent({
    cwd: "/repo",
    sessionId: "owner-1",
  });
  expect(sent).toBe(true);
  const request = vi.mocked(requestAgentContext).mock.calls.at(-1)?.[0];
  expect(request?.sourceSessionId).toBe("owner-1");
  expect(request?.cwd).toBe("/repo");
  expect(request?.requireDestinationSelection).toBe(false);
  const entries = request?.context.entries ?? [];
  expect(entries).toHaveLength(2);
  expect(entries[0].text).toContain("Working copy: /repo");
  expect(entries[0].text).toContain("Incoming ref: origin/main");
  expect(entries[0].text).toContain("src/app.ts");
  expect(entries[0].text).toContain("preserve both sides");
  expect(entries[1].text).toContain("<<<<<<< HEAD");
});

it("routes to the destination picker when the working copy has no owner", async () => {
  mockInvoke((command) => {
    if (command === "git_merge_context")
      return { merging: true, conflicts: ["a.ts"], mergeHead: null, diff: "" };
    if (command === "git_diff_index") return cleanIndex;
    return null;
  });
  await sendMergeConflictsToAgent({ cwd: "/repo" });
  const request = vi.mocked(requestAgentContext).mock.calls.at(-1)?.[0];
  expect(request?.requireDestinationSelection).toBe(true);
  expect(request?.sourceSessionId).toBeUndefined();
});

it("sends nothing when the merge already ended, leaving the tree alone", async () => {
  vi.mocked(requestAgentContext).mockClear();
  mockInvoke((command) =>
    command === "git_merge_context"
      ? { merging: false, conflicts: [], mergeHead: null, diff: "" }
      : null,
  );
  expect(await sendMergeConflictsToAgent({ cwd: "/repo" })).toBe(false);
  expect(requestAgentContext).not.toHaveBeenCalled();
});

it("aborts only after an explicit confirm", async () => {
  vi.mocked(ask).mockResolvedValueOnce(false);
  mockInvoke(() => null);
  expect(await abortMerge({ cwd: "/repo" })).toBe(false);
  expect(
    vi.mocked(invoke).mock.calls.some(([c]) => c === "git_merge_abort"),
  ).toBe(false);

  vi.mocked(ask).mockResolvedValueOnce(true);
  expect(await abortMerge({ cwd: "/repo" })).toBe(true);
  expect(
    vi.mocked(invoke).mock.calls.some(([c]) => c === "git_merge_abort"),
  ).toBe(true);
});
