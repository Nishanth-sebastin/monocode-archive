// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { InboxView } from "./InboxView";
import { clearInboxCache } from "../lib/githubTasks";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
  convertFileSrc: (path: string) => path,
}));
vi.mock("./AgentMarkdown", () => ({
  AgentMarkdown: ({ text }: { text: string }) => createElement("p", null, text),
}));
vi.mock("../chrome/WindowControls", () => ({ WindowControls: () => null }));

it("retains the selected Jira ticket and explicit project through handoff and refresh failures", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const stored = new Map<string, string>([["monocode.inboxSource", "jira"]]);
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => stored.get(key) ?? null,
    setItem: (key: string, value: string) => stored.set(key, value),
  });
  let failRefresh = false;
  vi.mocked(invoke).mockImplementation(async (cmd) => {
    if (cmd === "jira_status")
      return {
        connected: true,
        site: "https://team.atlassian.net",
        account: "Ada",
      };
    if (cmd.endsWith("_status")) return { connected: false };
    if (cmd === "jira_list_issues") {
      if (failRefresh) throw new Error("Jira permission error");
      return {
        site: "https://team.atlassian.net",
        issues: [42, 41].map((number) => ({
          id: String(number),
          key: `ENG-${number}`,
          fields: {
            summary: `Ticket ${number}`,
            status: {
              name: "In review",
              statusCategory: { key: "indeterminate" },
            },
            project: { id: "1", name: "Engineering" },
            updated: "2026-09-10T10:00:00Z",
          },
        })),
      };
    }
    if (cmd === "jira_issue_content")
      return {
        fields: {
          description: "Loaded description",
          creator: { displayName: "Ada" },
        },
        comments: [],
        total: 0,
      };
    if (cmd === "git_github_repo") return "";
    return [];
  });
  clearInboxCache();
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const onStart = vi.fn().mockRejectedValue(new Error("Handoff failed"));
  const button = (text: string) =>
    [...container.querySelectorAll("button")].find(
      (button) => button.textContent?.trim() === text,
    )!;
  const click = async (element: HTMLElement) => {
    await act(async () => {
      element.click();
    });
  };
  try {
    await act(async () => {
      root.render(
        createElement(InboxView, {
          cwd: "/local/project",
          recents: [],
          onAsk: async () => "",
          onAskRestart: async () => "",
          onAskMount: () => {},
          onStart,
        }),
      );
    });
    expect(container.querySelectorAll('[role="tab"]')).toHaveLength(4);
    await click(
      container.querySelector(
        '[aria-label="In review issue ENG-41: Ticket 41"]',
      )!,
    );
    await click(button("Send to agent"));
    expect(onStart).toHaveBeenCalledWith(
      expect.objectContaining({
        identifier: "ENG-41",
        site: "https://team.atlassian.net",
        projectPath: "/local/project",
        repo: "",
      }),
      "Loaded description",
    );
    expect(container.textContent).toContain("Handoff failed");
    await click(button("GitHub"));
    await click(button("Jira"));
    expect(container.querySelector("h1")?.textContent).toBe("Ticket 41");
    failRefresh = true;
    await click(container.querySelector('[aria-label="Refresh"]')!);
    expect(container.querySelector("h1")?.textContent).toBe("Ticket 41");
    expect(container.textContent).toContain("Jira permission error");
    await click(button("Retry"));
    expect(container.querySelector("h1")?.textContent).toBe("Ticket 41");
    expect(container.querySelector("textarea")).toBeNull();
  } finally {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  }
});
