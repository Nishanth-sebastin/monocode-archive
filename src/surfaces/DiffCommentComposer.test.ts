// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { DiffCommentComposer } from "./DiffCommentComposer";

it("keeps a typed comment when its diff snapshot is stale", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const onDismiss = vi.fn();

  try {
    await act(async () =>
      root.render(
        createElement(DiffCommentComposer, {
          path: "src/example.ts",
          target: {
            line: {
              kind: "add",
              text: "const current = true;",
              oldNumber: null,
              newNumber: 2,
            },
            anchor: new DOMRect(20, 20, 10, 10),
          },
          onBeforeSend: vi
            .fn()
            .mockRejectedValue(
              new Error(
                "This diff changed. Review the refreshed hunk and try again.",
              ),
            ),
          onDismiss,
        }),
      ),
    );
    const textarea = document.body.querySelector("textarea")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        "value",
      )?.set?.call(textarea, "Please keep this check.");
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
      textarea.dispatchEvent(new Event("change", { bubbles: true }));
    });
    const add = [...document.body.querySelectorAll("button")].find(
      (button) => button.textContent?.trim() === "Add to chat",
    )!;
    await act(async () => add.click());

    expect(document.body.querySelector("textarea")?.value).toBe(
      "Please keep this check.",
    );
    expect(
      document.body.querySelector('[role="alert"]')?.textContent,
    ).toContain("This diff changed");
    expect(onDismiss).not.toHaveBeenCalled();
  } finally {
    await act(async () => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  }
});
