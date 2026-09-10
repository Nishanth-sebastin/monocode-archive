// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { searchSessions } from "../lib/sessionStore";
import { AgentContextPicker } from "./AgentContextPicker";
import { contextFromText, contextFromTickets } from "../lib/agentContext";
import type { Session } from "../lib/session";

vi.mock("../lib/sessionStore", async original => ({ ...(await original<typeof import("../lib/sessionStore")>()), searchSessions: vi.fn().mockResolvedValue({ hits: [], truncated: false }) }));
vi.mock("./SecondOpinionButton", () => ({ SecondOpinionButton: () => null }));
vi.mock("./CwdPicker", () => ({ CwdPicker: () => null }));
vi.mock("../lib/session", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/session")>()),
  newDefaultSession: (cwd: string) => ({
    id: "fresh",
    harness: "codex",
    cwd,
    title: "New session",
  }),
}));

it("retains the destination after failure and opens it once after attaching context", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const sessions = [
    { id: "a", harness: "codex", cwd: "/a", title: "Source", busy: true },
    { id: "b", harness: "claude", cwd: "/b", title: "Recipient" },
  ] as Session[];
  const request = {
    context: contextFromText("Selection", "Only selected text", "/a message-2"),
    sourceSessionId: "a",
    cwd: "/a",
  };
  const onPrepare = vi
    .fn()
    .mockImplementationOnce(() => {
      throw new Error("Recipient closed");
    })
    .mockReturnValue("b");
  const onOpen = vi.fn(),
    onClose = vi.fn();
  const render = (available = sessions) =>
    root.render(
      createElement(AgentContextPicker, {
        request,
        sessions: available,
        recents: [],
        onPrepare,
        onOpen,
        onClose,
      }),
    );
  const button = (text: string) =>
    [...document.querySelectorAll("button")].find(
      (el) => el.textContent === text,
    )!;
  try {
    await act(async () => render());
    await act(async () =>
      (
        document.querySelector('button[data-destination="b"]') as HTMLElement
      ).click(),
    );
    await act(async () => button("Add to chat").click());
    expect(document.body.textContent).toContain("Recipient closed");
    expect(
      (
        document.querySelector('button[data-destination="b"]') as HTMLElement
      ).getAttribute("aria-pressed"),
    ).toBe("true");
    await act(async () => {
      const submit = button("Add to chat");
      submit.click();
      submit.click();
    });
    expect(onPrepare).toHaveBeenCalledTimes(2);
    expect(onPrepare).toHaveBeenLastCalledWith(
      expect.objectContaining({
        context: expect.objectContaining({ entries: request.context.entries }),
      }),
      "b",
      expect.any(AbortSignal),
    );
    expect(onOpen).toHaveBeenCalledExactlyOnceWith("b");
    expect(onClose).toHaveBeenCalledOnce();
    expect(document.body.textContent).not.toContain("Prepared in");
  } finally {
    await act(async () => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  }
});

it("opens a ticket conversation directly with compact choices and no preparation form", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const onPrepare = vi.fn().mockReturnValue("existing"),
    onOpen = vi.fn(),
    onClose = vi.fn();
  const ticket = {
    provider: "github",
    kind: "issue",
    number: 8,
    title: "Link tickets",
    state: "open",
    repo: "a/b",
    url: "https://github.com/a/b/issues/8",
    labels: [],
  } as import("../lib/githubTasks").InboxItem;
  try {
    await act(async () =>
      root.render(
        createElement(AgentContextPicker, {
          request: { context: contextFromTickets([ticket]), cwd: "/a" },
          sessions: [
            {
              id: "existing",
              harness: "codex",
              cwd: "/a",
              title: "Existing",
            } as Session,
          ],
          recents: [],
          onPrepare,
          onOpen,
          onClose,
        }),
      ),
    );
    expect(document.body.textContent).not.toContain("Unknown");
    expect(document.querySelector("textarea, input[type=radio]")).toBeNull();
    await act(async () =>
      (
        document.querySelector('[data-destination="existing"]') as HTMLElement
      ).click(),
    );
    await act(async () =>
      [...document.querySelectorAll("button")]
        .find((button) => button.textContent === "Open conversation")!
        .click(),
    );
    expect(onPrepare).toHaveBeenCalledTimes(1);
    expect(onOpen).toHaveBeenCalledWith("existing");
    expect(onClose).toHaveBeenCalledTimes(1);
  } finally {
    await act(async () => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  }
});

it("creates one conversation for a ticket bundle without reopening it through the existing-session path", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const onPrepare = vi.fn().mockReturnValue("fresh"),
    onOpen = vi.fn(),
    onClose = vi.fn();
  const ticket = {
    provider: "github",
    kind: "issue",
    number: 8,
    title: "Link tickets",
    state: "open",
    repo: "a/b",
    url: "https://github.com/a/b/issues/8",
    labels: [],
  } as import("../lib/githubTasks").InboxItem;
  try {
    await act(async () =>
      root.render(
        createElement(AgentContextPicker, {
          request: {
            context: contextFromTickets([
              ticket,
              {
                ...ticket,
                number: 13,
                url: "https://github.com/a/b/issues/13",
              },
            ]),
            cwd: "/a",
          },
          sessions: [],
          recents: [],
          onPrepare,
          onOpen,
          onClose,
        }),
      ),
    );
    await act(async () => {
      const submit = [...document.querySelectorAll("button")].find(
        (button) => button.textContent === "Open conversation",
      )!;
      submit.click();
      submit.click();
    });
    expect(onPrepare).toHaveBeenCalledTimes(1);
    expect(onPrepare.mock.calls[0][0].context.entries).toHaveLength(2);
    expect(onOpen).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledTimes(1);
  } finally {
    await act(async () => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  }
});

it("offers an inactive saved conversation without loading its transcript", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const host = document.createElement("div"); document.body.append(host);
  const root = createRoot(host);
  const onPrepare = vi.fn().mockResolvedValue("saved");
  try {
    await act(async () => root.render(createElement(AgentContextPicker, {
      request: { context: contextFromText("File", "snapshot", "/project"), cwd: "/project" }, sessions: [],
      history: [{ id: "saved", title: "Inactive conversation", cwd: "/project", harness: "codex", model: "", runtimeMode: "supervised", createdAt: 1, updatedAt: 2 }],
      recents: [], onPrepare, onOpen: vi.fn(), onClose: vi.fn(),
    })));
    await act(async () => (document.querySelector('[data-destination="saved"]') as HTMLButtonElement).click());
    await act(async () => [...document.querySelectorAll("button")].find(button => button.textContent === "Add to chat")!.click());
    expect(onPrepare).toHaveBeenCalledWith(expect.anything(), "saved", expect.any(AbortSignal));
  } finally { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); }
});

it("searches saved conversations across projects", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.useFakeTimers();
  vi.mocked(searchSessions).mockResolvedValueOnce({ hits: [{ kind: "conversation", sessionId: "remote-saved", title: "Other project task", cwd: "/other/project", harness: "claude", updatedAt: 1 }], truncated: false });
  const host = document.createElement("div"); document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () => root.render(createElement(AgentContextPicker, { request: { context: contextFromText("File", "body", "/current"), cwd: "/current" }, sessions: [], recents: [], onPrepare: vi.fn(), onOpen: vi.fn(), onClose: vi.fn() })));
    const input = document.querySelector('[aria-label="Search conversations"]') as HTMLInputElement;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "Other project");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => { await vi.advanceTimersByTimeAsync(250); });
    expect(searchSessions).toHaveBeenCalledWith({ query: "Other project", includeArchived: false });
    expect(document.querySelector('[data-destination="remote-saved"]')?.textContent).toContain("/other/project");
  } finally { await act(async () => root.unmount()); host.remove(); vi.useRealTimers(); vi.unstubAllGlobals(); }
});
