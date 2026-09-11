// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { buildUnifiedFile } from "../lib/unifiedDiff";
import { UnifiedDiffView } from "./UnifiedDiffView";

it("labels a staged hunk action as unstage", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      constructor(private readonly callback: IntersectionObserverCallback) {}
      observe(target: Element) {
        this.callback(
          [{ isIntersecting: true, target } as IntersectionObserverEntry],
          this as unknown as IntersectionObserver,
        );
      }
      disconnect() {}
      unobserve() {}
      takeRecords() {
        return [];
      }
    },
  );
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
      unobserve() {}
    },
  );
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const onHunkAction = vi.fn();
  const diff = buildUnifiedFile("alpha\nbeta\n", "alpha\nBETA\n");

  try {
    await act(async () =>
      root.render(
        createElement(UnifiedDiffView, {
          files: [
            {
              id: "staged:a.ts",
              path: "/repo/a.ts",
              label: "a.ts",
              additions: diff.additions,
              deletions: diff.deletions,
              blocks: diff.blocks,
              hunkAction: "unstage",
            },
          ],
          onHunkAction,
        }),
      ),
    );

    const action = host.querySelector<HTMLButtonElement>(
      'button[aria-label="Unstage hunk"]',
    )!;
    expect(action).not.toBeNull();
    await act(async () => action.click());
    expect(onHunkAction).toHaveBeenCalledWith(
      "staged:a.ts",
      expect.any(Number),
    );
  } finally {
    await act(async () => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  }
});
