import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { InboxMiniCard } from "./InboxMiniCard";
import type { InboxComposerCard } from "../lib/githubTasks";

it("keeps the source and labels in the original full-width row above context", () => {
  const card: InboxComposerCard = {
    provider: "github",
    kind: "issue",
    identifier: "#11",
    title: "Ticket title",
    url: "https://github.com/team/project/issues/11",
    source: "team/project",
    labels: [{ name: "enhancement", color: "a2eeef" }],
    prompt: "",
  };
  const original = renderToStaticMarkup(createElement(InboxMiniCard, { card }));
  const selected = renderToStaticMarkup(
    createElement(InboxMiniCard, {
      card: { ...card, contextSummary: "Description · 0 comments · 0 files" },
    }),
  );
  const button = (markup: string) =>
    markup.match(/<button\b[^]*?<\/button>/)?.[0];
  expect(button(selected)).toBe(button(original));
  expect(button(selected)).toContain(
    "mt-1 flex w-full min-w-0 items-center gap-2",
  );
  expect(selected.indexOf("enhancement")).toBeLessThan(
    selected.indexOf("next message only"),
  );
});
