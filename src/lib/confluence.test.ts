// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import {
  confluenceMarkdown,
  confluencePageContext,
  confluenceSections,
  type ConfluencePage,
} from "./confluence";
import { MAX_CONTEXT_TEXT } from "./agentContext";

const site = "https://team.atlassian.net";

const page = (storage: string, extra: Partial<ConfluencePage> = {}): ConfluencePage => ({
  id: "123456",
  title: "Rollout plan",
  spaceKey: "ENG",
  spaceName: "Engineering",
  version: 7,
  updatedAt: "2026-01-01T00:00:00Z",
  url: `${site}/wiki/spaces/ENG/pages/123456`,
  excerpt: "",
  storage,
  ...extra,
});

describe("confluenceMarkdown", () => {
  it("converts headings, lists, and code macros to readable markdown", () => {
    const storage = [
      "<h2>Overview</h2>",
      "<p>Ship <strong>phase&nbsp;one</strong></p>",
      "<ul><li>Alpha</li><li>Beta</li></ul>",
      '<ac:structured-macro ac:name="code"><ac:plain-text-body><![CDATA[const x = 1;]]></ac:plain-text-body></ac:structured-macro>',
    ].join("");
    const { text, truncated } = confluenceMarkdown(storage);
    expect(truncated).toBe(false);
    expect(text).toContain("## Overview");
    expect(text).toContain("**phase");
    expect(text).toContain("- Alpha");
    expect(text).toContain("const x = 1;");
  });

  it("drops executable markup and unsafe links", () => {
    const storage = [
      "<p>Hi</p><script>exfiltrate()</script><style>body{}</style>",
      '<iframe src="https://tracker.test/x"></iframe>',
      '<a href="javascript:alert(1)">click</a>',
      '<a href="https://safe.test/page">safe</a>',
    ].join("");
    const { text } = confluenceMarkdown(storage);
    expect(text).toContain("Hi");
    for (const unsafe of ["exfiltrate", "tracker.test", "javascript:", "alert(1)"])
      expect(text).not.toContain(unsafe);
    expect(text).toContain("[safe](https://safe.test/page)");
  });

  it("reduces macros to readable bodies and marks large pages truncated", () => {
    const note =
      '<ac:structured-macro ac:name="info"><ac:rich-text-body><p>Heads up</p></ac:rich-text-body></ac:structured-macro>';
    const { text } = confluenceMarkdown(note);
    expect(text).toContain("Heads up");
    expect(confluenceMarkdown(`<p>${"a".repeat(300_000)}</p>`).truncated).toBe(
      true,
    );
  });
});

describe("confluenceSections", () => {
  it("splits markdown into heading-bounded sections without child duplication", () => {
    const markdown = [
      "# Intro",
      "",
      "Intro body",
      "",
      "## Detail",
      "",
      "Detail body",
      "",
      "### Sub",
      "",
      "Sub body",
      "",
      "# Other",
      "",
      "Other body",
    ].join("\n");
    const sections = confluenceSections(markdown);
    expect(sections.map((section) => section.title)).toEqual([
      "Intro",
      "Detail",
      "Sub",
      "Other",
    ]);
    expect(sections[1].text).toBe("Detail body");
    expect(sections[1].level).toBe(2);
    expect(sections[2].level).toBe(3);
  });
});

describe("confluencePageContext", () => {
  it("records site/space/page/version/URL provenance per entry", () => {
    const context = confluencePageContext(site, [
      { page: page("<p>Body</p>"), sections: null },
    ]);
    const entry = context.entries[0];
    expect(entry.title).toBe("ENG: Rollout plan");
    for (const part of [
      site,
      "space ENG",
      "page 123456",
      "v7",
      page("").url,
    ])
      expect(entry.origin).toContain(part);
    expect(entry.text).toContain("Body");
    expect(entry.truncated).toBe(false);
  });

  it("keeps only selected sections and notes the section count", () => {
    const context = confluencePageContext(site, [
      {
        page: page("<h2>Keep</h2><p>Keep body</p><h2>Skip</h2><p>Skip body</p>"),
        sections: ["s0"],
      },
    ]);
    const entry = context.entries[0];
    expect(entry.origin).toContain("1 section");
    expect(entry.text).toContain("Keep body");
    expect(entry.text).not.toContain("Skip body");
  });

  it("bounds entry text and marks truncation", () => {
    const context = confluencePageContext(site, [
      { page: page(`<p>${"x".repeat(MAX_CONTEXT_TEXT + 100)}</p>`), sections: null },
    ]);
    const entry = context.entries[0];
    expect(entry.truncated).toBe(true);
    expect(entry.text.length).toBeLessThanOrEqual(MAX_CONTEXT_TEXT);
  });
});
