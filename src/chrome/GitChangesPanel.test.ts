// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { GitChangesPanel } from "./GitChangesPanel";
import {
  contextFromChanges,
  contextFromText,
  requestAgentContext,
} from "../lib/agentContext";
vi.mock("../lib/agentContext", async (original) => ({
  ...(await original<typeof import("../lib/agentContext")>()),
  contextFromChanges: vi.fn(),
  requestAgentContext: vi.fn(),
}));
vi.mock("./GitHistoryGraph", () => ({
  GitHistoryGraph: () => null,
  GraphResizeSash: () => null,
  GRAPH_PANEL_DEFAULT: 180,
  GRAPH_PANEL_MIN: 80,
  loadGraphPanelHeight: () => 180,
  saveGraphPanelHeight: () => {},
}));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (command: string) =>
    command === "git_diff_index"
      ? {
          branch: "feature",
          ahead: 0,
          behind: 0,
          files: [
            {
              path: "/repo/a.ts",
              relative: "a.ts",
              status: "modified",
              staged: false,
              unstaged: true,
              additions: 1,
              deletions: 0,
            },
          ],
        }
      : null,
  ),
}));
it("keeps changes selected until the chosen recipient accepts context", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  vi.mocked(contextFromChanges).mockResolvedValue(
    contextFromText("a.ts", "patch", "/repo"),
  );
  const button = (text: string) =>
    [...host.querySelectorAll("button")].find(
      (button) => button.textContent?.trim() === text,
    )!;
  try {
    await act(async () =>
      root.render(
        createElement(GitChangesPanel, {
          cwd: "/repo",
          sourceSessionId: "original",
          enabled: true,
          onOpenFile: vi.fn(),
          onOpenAllChanges: vi.fn(),
          onOpenCommit: vi.fn(),
        }),
      ),
    );
    expect(
      [...host.querySelectorAll("button")].filter(
        (button) => button.getAttribute("aria-label") === "Pull requests",
      ),
    ).toHaveLength(1);
    expect(
      [...host.querySelectorAll("button")].filter(
        (button) => button.getAttribute("aria-label") === "CI",
      ),
    ).toHaveLength(1);
    await act(async () =>
      (
        host.querySelector(
          'button[aria-label="Select files for agent"]',
        ) as HTMLButtonElement
      ).click(),
    );
    const checkbox = () =>
      host.querySelector('input[type="checkbox"]') as HTMLInputElement;
    await act(async () => checkbox().click());
    await act(async () => button("Send to agent…").click());
    expect(checkbox().checked).toBe(true);
    expect(requestAgentContext).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceSessionId: "original",
        prepareInSource: false,
      }),
    );
    // Closing the picker has no success callback: the selected files remain available.
    await act(async () => button("Send to agent…").click());
    expect(checkbox().checked).toBe(true);
    await act(async () =>
      vi.mocked(requestAgentContext).mock.calls.at(-1)![0].onPrepared!(),
    );
    expect(checkbox()).toBeNull();
  } finally {
    await act(async () => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  }
});

it("updates PR and CI rows when their exact conversation associations change", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const rows = new Map<string, string>();
  vi.stubGlobal("localStorage", { getItem: (key: string) => rows.get(key) ?? null, setItem: (key: string, value: string) => rows.set(key, value) });
  const { saveAzurePrAssociation } = await import("../lib/azureRepos");
  const { saveCiSources } = await import("../lib/azurePipelines");
  const host = document.createElement("div"); document.body.append(host);
  const root = createRoot(host);
  const open = vi.fn();
  const prRow = () => host.querySelector('button[aria-label="Pull requests"]') as HTMLButtonElement;
  const ciRow = () => host.querySelector('button[aria-label="CI"]') as HTMLButtonElement;
  const association = {
    cwd: "/repo", branch: "feature", sourceSessionId: "owner", account: "Ada", projectName: "Project", repositoryName: "repo", revision: "head:base",
    target: { site: "https://dev.azure.com/team", accountId: "ada", project: "project", repository: "repo", number: 13 },
    pr: { pullRequestId: 13, title: "Fix login", status: "active", sourceRefName: "refs/heads/feature", targetRefName: "refs/heads/main", reviewers: [{ id: "reviewer", displayName: "Sam", vote: -5 }] },
  };
  try {
    await act(async () => root.render(createElement(GitChangesPanel, { cwd: "/repo", sourceSessionId: "owner", enabled: true, onOpenDelivery: open, onOpenFile: vi.fn(), onOpenAllChanges: vi.fn(), onOpenCommit: vi.fn() })));
    await act(async () => saveAzurePrAssociation({ ...association, sourceSessionId: "other" }, "/repo", "feature", "other"));
    expect(prRow().textContent).not.toContain("Fix login");
    await act(async () => saveAzurePrAssociation(association, "/repo", "feature", "owner"));
    expect(prRow().textContent).toContain("#13 Fix login");
    expect(prRow().textContent).toContain("Needs attention · saved");
    await act(async () => prRow().click());
    expect(open).toHaveBeenLastCalledWith("/repo", { kind: "pr", branch: "feature", sourceSessionId: "owner" });
    const target = { site: "https://dev.azure.com/team", accountId: "ada", project: "project", definition: 7, repositoryId: "team/repo", repositoryType: "GitHub", repositoryUrl: "https://github.com/team/repo" };
    await act(async () => saveCiSources([{ target, cwd: "/repo", branch: "feature", session: "owner", remote: target.repositoryUrl, definitionName: "Unit tests", projectName: "Project" }], "/repo", "feature", "owner"));
    expect(ciRow().textContent).toContain("Unit tests");
    await act(async () => saveAzurePrAssociation(null, "/repo", "feature", "owner", association.target));
    expect(prRow().textContent).not.toContain("Fix login");
  } finally { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); }
});
