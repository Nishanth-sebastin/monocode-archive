// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { GitChangesPanel } from "./GitChangesPanel";
import { contextFromChanges, contextFromText, requestAgentContext } from "../lib/agentContext";
vi.mock("../lib/agentContext", async original => ({ ...(await original<typeof import("../lib/agentContext")>()), contextFromChanges: vi.fn(), requestAgentContext: vi.fn() }));
vi.mock("./GitHistoryGraph", () => ({ GitHistoryGraph: () => null, GraphResizeSash: () => null, GRAPH_PANEL_DEFAULT: 180, GRAPH_PANEL_MIN: 80, loadGraphPanelHeight: () => 180, saveGraphPanelHeight: () => {} }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async (command: string) => command === "git_diff_index" ? { branch: "feature", ahead: 0, behind: 0, files: [{ path: "/repo/a.ts", relative: "a.ts", status: "modified", staged: false, unstaged: true, additions: 1, deletions: 0 }] } : null) }));
it("keeps changes selected until the chosen recipient accepts context", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const host = document.createElement("div"); document.body.append(host);
  const root = createRoot(host);
  vi.mocked(contextFromChanges).mockResolvedValue(contextFromText("a.ts", "patch", "/repo"));
  const button = (text: string) => [...host.querySelectorAll("button")].find(button => button.textContent?.trim() === text)!;
  try {
    await act(async () => root.render(createElement(GitChangesPanel, { cwd: "/repo", sourceSessionId: "original", enabled: true, onOpenFile: vi.fn(), onOpenAllChanges: vi.fn(), onOpenCommit: vi.fn() })));
    expect([...host.querySelectorAll("button")].filter(button => button.textContent?.trim() === "Review Azure PRs")).toHaveLength(1);
    expect([...host.querySelectorAll("button")].filter(button => button.textContent?.includes("Azure Pipelines"))).toHaveLength(1);
    await act(async () => button("Select changes").click());
    const checkbox = () => host.querySelector('input[type="checkbox"]') as HTMLInputElement;
    await act(async () => checkbox().click());
    await act(async () => button("Send to agent…").click());
    expect(checkbox().checked).toBe(true);
    expect(requestAgentContext).toHaveBeenCalledWith(expect.objectContaining({ sourceSessionId: "original", prepareInSource: false }));
    // Closing the picker has no success callback: the selected files remain available.
    await act(async () => button("Send to agent…").click());
    expect(checkbox().checked).toBe(true);
    await act(async () => vi.mocked(requestAgentContext).mock.calls.at(-1)![0].onPrepared!());
    expect(checkbox()).toBeNull();
  } finally { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); }
});
