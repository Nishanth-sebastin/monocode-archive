// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { AgentContextPicker } from "./AgentContextPicker";
import { contextFromText } from "../lib/agentContext";
import type { Session } from "../lib/session";

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

it("retains the selected destination after failure, prevents duplicate preparation and never auto-opens existing sessions", async () => {
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
      (document.querySelector('input[value="b"]') as HTMLElement).click(),
    );
    await act(async () => button("Prepare in chat").click());
    expect(document.body.textContent).toContain("Recipient closed");
    expect(
      (document.querySelector('input[value="b"]') as HTMLInputElement).checked,
    ).toBe(true);
    await act(async () => {
      const submit = button("Prepare in chat");
      submit.click();
      submit.click();
    });
    expect(onPrepare).toHaveBeenCalledTimes(2);
    expect(onPrepare).toHaveBeenLastCalledWith(
      expect.objectContaining({
        context: expect.objectContaining({ entries: request.context.entries }),
      }),
      "b",
    );
    expect(onOpen).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    await act(async () => button("Open conversation").click());
    expect(onOpen).toHaveBeenCalledWith("b");
  } finally {
    await act(async () => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  }
});
