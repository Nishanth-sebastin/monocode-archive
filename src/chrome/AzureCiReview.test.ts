// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { beforeEach, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { AzureCiReview } from "./AzureCiReview";
import { PREPARE_AGENT_CONTEXT } from "../lib/agentContext";
import { saveCiSources, type CiSource } from "../lib/azurePipelines";
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({
  emit: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@tauri-apps/plugin-opener", () => ({
  openUrl: vi.fn().mockResolvedValue(undefined),
}));
const target = {
  site: "https://dev.azure.com/team",
  accountId: "account-a",
  project: "project-a",
  definition: 7,
  repositoryId: "team/repo",
  repositoryType: "GitHub",
  repositoryUrl: "https://github.com/team/repo",
};
const source: CiSource = {
  target,
  cwd: "wsl://Ubuntu/work/repo",
  branch: "feature",
  session: "owner",
  remote: target.repositoryUrl,
  definitionName: "Tests",
  projectName: "Project",
};
const run = {
  id: 12,
  number: "12",
  status: "completed",
  result: "failed",
  branch: "refs/heads/feature",
  commit: "head",
  revision: "run-attempt-1",
  match: "exact",
  queuedAt: "now",
};
let stale = false;
beforeEach(() => {
  stale = false;
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const rows = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => rows.get(key) ?? null,
    setItem: (key: string, value: string) => rows.set(key, value),
  });
  vi.mocked(invoke)
    .mockReset()
    .mockImplementation(async (command, args) => {
      const input = (
        args as {
          input?: {
            target: typeof target;
            section: string;
            runId: number;
            skip?: number;
          };
        }
      )?.input;
      if (command === "azure_status")
        return {
          connected: true,
          site: target.site,
          accountId: target.accountId,
          account: "Ada",
          project: "Project",
          capabilities: ["Pipelines"],
        };
      if (command === "azure_ci_context")
        return {
          cwd: source.cwd,
          branch: "feature",
          commit: "head",
          remotes: [{ name: "origin", url: source.remote }],
        };
      if (command === "azure_ci_lookup") {
        if (input?.target.definition === 8)
          throw new Error("Pipeline access denied");
        return {
          target,
          projectName: "Project",
          definitionName: "Tests",
          checkedAt: 1,
          continuation: null,
          items: [
            run,
            {
              ...run,
              id: 11,
              result: "succeeded",
              commit: "old",
              match: "old-commit",
            },
          ],
        };
      }
      if (command === "azure_ci_read") {
        if (stale)
          throw new Error(
            "Run changed or was retried. Refresh CI evidence before continuing.",
          );
        if (input?.section === "summary")
          return input.runId === 11
            ? {
                ...run,
                id: 11,
                result: "succeeded",
                commit: "old",
                match: "old-commit",
              }
            : run;
        if (input?.section === "jobs")
          return {
            items: [
              {
                id: "job",
                name: "Unit tests",
                type: "Task",
                attempt: 2,
                state: "completed",
                result: "failed",
                logId: 9,
              },
            ],
            nextSkip: null,
            timelineId: "timeline",
          };
        if (input?.section === "log")
          return {
            text: "expected 1, got 2",
            startLine: 0,
            endLine: 1,
            lineCount: 2,
            recordId: "job",
            attempt: 2,
            logId: 9,
            bounded: true,
          };
      }
      throw new Error(`Unexpected ${command}`);
    });
});
const find = (text: string) =>
  [...document.querySelectorAll("button")].find(
    (el) => el.textContent?.trim() === text,
  )!;
const click = async (text: string) => {
  await act(async () => find(text).click());
};
async function setup(sources: CiSource[] = [source]) {
  saveCiSources(sources, source.cwd, source.branch, source.session);
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () =>
    root.render(
      createElement(AzureCiReview, {
        cwd: source.cwd,
        branch: source.branch,
        sourceSessionId: source.session,
        enabled: true,
      }),
    ),
  );
  return async () => {
    await act(async () => root.unmount());
    host.remove();
  };
}
it("loads independent source errors, selected jobs and bounded logs, and prepares one scoped handoff", async () => {
  const cleanup = await setup([
    source,
    {
      ...source,
      target: { ...target, definition: 8 },
      definitionName: "Other source",
    },
  ]);
  const handoff = vi.fn();
  window.addEventListener(PREPARE_AGENT_CONTEXT, handoff);
  try {
    expect(invoke).not.toHaveBeenCalled();
    await click("Azure Pipelines · 2 configured");
    expect(document.body.textContent).toContain("Pipeline access denied");
    expect(document.body.textContent).toContain("Old commit");
    expect(
      vi
        .mocked(invoke)
        .mock.calls.some(
          ([, arg]) =>
            (arg as { input?: { section: string } })?.input?.section === "log",
        ),
    ).toBe(false);
    await click(
      "Run 12 · 12 · FailedCurrent checkout commit · head · refs/heads/feature",
    );
    await click("Load jobs");
    await click("Load log · Unit tests");
    expect(document.body.textContent).toContain("expected 1, got 2");
    await act(async () => [...document.querySelectorAll("button")].find(button => button.textContent?.trim() === "Refresh runs")!.click());
    expect(document.body.textContent).toContain("expected 1, got 2");
    await act(async () => {
      find("Send log to agent").click();
      find("Send log to agent").click();
    });
    expect(handoff).toHaveBeenCalledTimes(1);
    const request = (handoff.mock.calls[0][0] as CustomEvent).detail;
    expect(request.sourceSessionId).toBe("owner");
    expect(request.cwd).toBe(source.cwd);
    expect(JSON.stringify(request.context)).toContain("attempt: 2");
  } finally {
    window.removeEventListener(PREPARE_AGENT_CONTEXT, handoff);
    await cleanup();
  }
});
it("prevents a stale run or an old successful commit from being handed to an agent", async () => {
  const cleanup = await setup();
  const handoff = vi.fn();
  window.addEventListener(PREPARE_AGENT_CONTEXT, handoff);
  try {
    await click("Azure Pipelines · 1 configured");
    await click("Run 11 · 12 · PassedOld commit · old · refs/heads/feature");
    await click("Load jobs");
    await click("Load log · Unit tests");
    expect(find("Send log to agent").disabled).toBe(true);
    await click(
      "Run 12 · 12 · FailedCurrent checkout commit · head · refs/heads/feature",
    );
    await click("Load jobs");
    await click("Load log · Unit tests");
    stale = true;
    await click("Send log to agent");
    expect(handoff).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain("Run changed or was retried");
  } finally {
    window.removeEventListener(PREPARE_AGENT_CONTEXT, handoff);
    await cleanup();
  }
});
