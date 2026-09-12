// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  isTaskPrCreating,
  loadTaskPrDraft,
  markTaskPrCreating,
  prCommitBody,
  prRowBlocker,
  saveTaskPrDraft,
  withRelatedPrs,
} from "./taskPrs";
import type { GitPrCheck } from "./fs";

beforeEach(() => {
  const rows = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => rows.get(key) ?? null,
    setItem: (key: string, value: string) => rows.set(key, value),
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

const check = (patch: Partial<GitPrCheck> = {}): GitPrCheck => ({
  branch: "feature",
  remote: "origin",
  upstream: "origin/feature",
  defaultBranch: "main",
  dirtyFiles: 0,
  dirtyLimited: false,
  published: true,
  aheadOfRemote: 0,
  targetExists: true,
  ahead: 2,
  behind: 0,
  commits: ["one", "two"],
  ...patch,
});

it("round-trips row drafts and merges partial updates", () => {
  saveTaskPrDraft("task", "child", { target: "dev", title: "Task name" });
  saveTaskPrDraft("task", "child", { body: "notes", draft: true });
  const draft = loadTaskPrDraft("task", "child");
  expect(draft).toMatchObject({
    target: "dev",
    title: "Task name",
    body: "notes",
    draft: true,
  });
  // Rows for other children/tasks stay independent.
  expect(loadTaskPrDraft("task", "other")).toBeNull();
  expect(loadTaskPrDraft("other", "child")).toBeNull();
  saveTaskPrDraft("task", "child", { provider: "azure" });
  expect(loadTaskPrDraft("task", "child")?.provider).toBe("azure");
  saveTaskPrDraft("task", "child", { provider: null });
  expect(loadTaskPrDraft("task", "child")?.provider).toBeUndefined();
});

it("drops invalid rows and keeps verified results only", () => {
  localStorage.setItem(
    "monocode.taskPrDrafts.v1",
    JSON.stringify({
      "t:ok": {
        target: "dev",
        title: "t",
        body: "b",
        updatedAt: 1,
        result: {
          provider: "github",
          url: "https://github.com/a/b/pull/3",
          title: "T",
          number: 3,
        },
      },
      "t:bad-result": {
        target: "dev",
        title: "t",
        body: "b",
        updatedAt: 2,
        result: { provider: "github", url: "javascript:alert(1)" },
      },
      "t:huge": {
        target: "dev",
        title: "x".repeat(501),
        body: "",
        updatedAt: 3,
      },
      "t:azure": {
        target: "dev",
        title: "t",
        body: "",
        updatedAt: 4,
        result: {
          provider: "azure",
          url: "https://dev.azure.com/o/p/_git/r/pullrequest/7",
          azureTarget: {
            site: "https://dev.azure.com/o",
            accountId: "acc",
            project: "p",
            repository: "r",
            number: 7,
          },
        },
      },
    }),
  );
  expect(loadTaskPrDraft("t", "ok")?.result?.number).toBe(3);
  expect(loadTaskPrDraft("t", "bad-result")?.result).toBeUndefined();
  expect(loadTaskPrDraft("t", "huge")).toBeNull();
  expect(loadTaskPrDraft("t", "azure")?.result?.azureTarget?.number).toBe(7);
});

it("bounds stored rows to the 100 most recently updated", () => {
  for (let index = 0; index < 110; index += 1) {
    saveTaskPrDraft("t", `c${index}`, { target: "dev" });
  }
  expect(loadTaskPrDraft("t", "c109")).not.toBeNull();
  expect(loadTaskPrDraft("t", "c0")).toBeNull();
});

it("tracks in-flight creates per row", () => {
  markTaskPrCreating("t", "c", true);
  expect(isTaskPrCreating("t", "c")).toBe(true);
  expect(isTaskPrCreating("t", "other")).toBe(false);
  markTaskPrCreating("t", "c", false);
  expect(isTaskPrCreating("t", "c")).toBe(false);
});

it("blocks rows that cannot produce a pull request", () => {
  expect(prRowBlocker(check({ branch: null }), "dev")).toContain("detached");
  expect(prRowBlocker(check({ branch: "dev" }), "dev")).toContain("same branch");
  expect(prRowBlocker(check({ remote: null }), "dev")).toContain("remote");
  expect(prRowBlocker(check({ dirtyFiles: 3 }), "dev")).toContain("uncommitted");
  expect(prRowBlocker(check({ targetExists: false }), "dev")).toContain(
    "No branch named dev",
  );
  expect(prRowBlocker(check({ ahead: 0 }), "dev")).toContain("no commits");
  // Behind the target is allowed — the PR just merges older work.
  expect(prRowBlocker(check({ behind: 5 }), "dev")).toBeNull();
  expect(prRowBlocker(check(), "dev")).toBeNull();
});

it("builds a bounded fallback body from commit subjects", () => {
  const body = prCommitBody(["add sheet", "wire store"]);
  expect(body).toContain("- add sheet");
  expect(body).toContain("## Testing");
  expect(prCommitBody([])).toContain("See commits");
  expect(prCommitBody(Array.from({ length: 30 }, (_, i) => `c${i}`)).match(/-/g)?.length).toBeLessThan(30);
});

const related = [
  { repo: "api", title: "Task", url: "https://github.com/a/api/pull/1" },
  { repo: "web", title: "Task", url: "https://dev.azure.com/o/p/_git/web/pullrequest/2" },
];

it("appends and idempotently replaces the related-PRs section", () => {
  const body = "## Summary\n- things\n";
  const once = withRelatedPrs(body, related);
  expect(once).toContain("## Related pull requests");
  expect(once).toContain("**api**");
  expect(once).toContain("**web**");
  const twice = withRelatedPrs(once, related);
  expect(twice).toBe(once);
  // Hand-edited text above the markers survives a retry.
  const edited = once.replace("things", "edited things");
  const reRun = withRelatedPrs(edited, [
    { repo: "worker", title: "Task", url: "https://github.com/a/worker/pull/3" },
  ]);
  expect(reRun).toContain("edited things");
  expect(reRun).toContain("**worker**");
  expect(reRun).not.toContain("**api**");
});

it("removes the section when no same-target siblings remain", () => {
  const linked = withRelatedPrs("body", related);
  expect(withRelatedPrs(linked, [])).toBe("body");
});

it("skips unusable entries and neutralizes markup in names", () => {
  const body = withRelatedPrs("body", [
    { repo: "ok", title: "T", url: "https://github.com/a/b/pull/1" },
    { repo: "bad", title: "T", url: "javascript:alert(1)" },
    { repo: "spaced", title: "T", url: "https://a.com/p r" },
    { repo: "x**y**", title: "[t](u)", url: "https://github.com/a/c/pull/2" },
  ]);
  expect(body).toContain("**ok**");
  expect(body).not.toContain("javascript:");
  expect(body).not.toContain("p r");
  expect(body).toContain("**xy**");
});
