// @vitest-environment happy-dom
import { act, createElement, type ComponentProps } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { PaneTree } from "./PaneTree";
import { newSession } from "../lib/session";
vi.mock("./SessionPane", () => ({ SessionPane: () => createElement("textarea", { defaultValue: "draft retained", "aria-label": "Composer" }) }));
vi.mock("./FilePane", () => ({ FilePane: () => null }));
it("moves one mounted composer into Inbox and back without losing its draft", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const host = document.createElement("div"), inbox = document.createElement("div");
  document.body.append(host, inbox); const root = createRoot(host);
  const session = newSession("codex", "/a");
  const props = { visible: true, layout: { type: "leaf", id: session.id }, sessions: [session], editorPanes: [], dirtyFileIds: new Set(), fileErrorCounts: new Map(), focusedId: session.id, recents: [] } as unknown as ComponentProps<typeof PaneTree>;
  try {
    await act(async () => root.render(createElement(PaneTree, props)));
    const composer = host.querySelector("textarea")!;
    composer.value = "my unsent draft";
    await act(async () => root.render(createElement(PaneTree, { ...props, visible: false, sessionPortal: { sessionId: session.id, host: inbox } })));
    expect(inbox.querySelectorAll("textarea")).toHaveLength(1);
    expect(inbox.querySelector("textarea")).toBe(composer);
    await act(async () => root.render(createElement(PaneTree, { ...props, visible: false })));
    expect(inbox.querySelector("textarea")).toBeNull();
    expect(host.querySelector("textarea")).toBe(composer);
    expect(composer.value).toBe("my unsent draft");
  } finally { await act(async () => root.unmount()); host.remove(); inbox.remove(); vi.unstubAllGlobals(); }
});
