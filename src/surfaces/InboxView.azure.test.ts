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
it("keeps Azure identity, selected context and local project through Ask, Send and retry", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const stored = new Map<string, string>([["monocode.inboxSource", "azure"]]);
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => stored.get(key) ?? null,
    setItem: (key: string, value: string) => stored.set(key, value),
  });
  let fail = false;
  vi.mocked(invoke).mockImplementation(async (cmd) => {
    if (cmd === "azure_status")
      return {
        connected: true,
        site: "https://dev.azure.com/team",
        project: "Product",
        account: "Ada",
        accountId: "ada",
      };
    if (cmd.endsWith("_status")) return { connected: false };
    if (cmd === "azure_list_items") {
      if (fail) throw new Error("Azure denied access");
      return {
        site: "https://dev.azure.com/team",
        items: [142, 141].map((id) => ({
          id,
          stateCategory: "InProgress",
          fields: {
            "System.Title": `Ticket ${id}`,
            "System.State": "Custom review",
            "System.TeamProject": "Product",
            "System.WorkItemType": "Bug",
            "System.ChangedDate": "2026-09-10T10:00:00Z",
          },
        })),
      };
    }
    if (cmd === "azure_item_content")
      return {
        fields: { "System.Description": "<p>Loaded description</p>" },
        comments: [],
        more: false,
      };
    if (cmd === "inbox_context_document")
      return {
        owner: "azure:team:ada",
        description: "Loaded description",
        comments: [],
        files: [],
        more: false,
      };
    if (cmd === "git_github_repo") return "";
    return [];
  });
  clearInboxCache();
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const onStart = vi.fn().mockRejectedValue(new Error("Handoff failed"));
  const onAsk = vi.fn().mockResolvedValue("ask-session");
  const button = (text: string) =>
    [...document.querySelectorAll("button")].find(
      (b) => b.textContent?.trim() === text,
    )!;
  const click = async (el: HTMLElement) => {
    await act(async () => el.click());
  };
  try {
    await act(async () =>
      root.render(
        createElement(InboxView, {
          cwd: "/local/project",
          recents: [],
          onAsk,
          onAskRestart: async () => "",
          onAskMount: () => {},
          onStart,
        }),
      ),
    );
    expect(
      container.querySelector('[role="tab"][aria-label="Azure Boards"]'),
    ).not.toBeNull();
    await click(
      container.querySelector(
        '[aria-label="Custom review issue Bug 141: Ticket 141"]',
      )!,
    );
    await click(button("Send to agent"));
    expect(onStart).not.toHaveBeenCalled();
    await click(button("Open agent draft"));
    expect(onStart).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "azure",
        identifier: "Bug 141",
        projectPath: "/local/project",
        repo: "",
        site: "https://dev.azure.com/team",
      }),
      undefined,
      expect.objectContaining({
        prompt: expect.stringContaining("Loaded description"),
      }),
    );
    expect(document.body.textContent).toContain("Handoff failed");
    await click(button("Cancel"));
    await click(button("GitHub"));
    await click(button("Azure"));
    expect(container.querySelector("h1")?.textContent).toBe("Ticket 141");
    fail = true;
    await click(container.querySelector('[aria-label="Refresh"]')!);
    expect(container.querySelector("h1")?.textContent).toBe("Ticket 141");
    expect(container.textContent).toContain("Azure denied access");
    expect(container.querySelector("textarea")).toBeNull();
    await click(button("Ask"));
    await click(button("Open discussion"));
    expect(onAsk).toHaveBeenCalledWith(
      expect.objectContaining({ provider: "azure", id: "141" }),
      expect.objectContaining({ contextSummary: expect.any(String) }),
    );
  } finally {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  }
});
