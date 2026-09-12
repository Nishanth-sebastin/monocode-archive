import { describe, expect, it } from "vitest";
import type { InboxItem } from "./githubTasks";
import {
  groupInboxRelations,
  type InboxRelationEdge,
} from "./inboxRelations";

const item = (number: number, over: Partial<InboxItem> = {}): InboxItem => ({
  provider: "jira",
  kind: "jira",
  id: String(number),
  number,
  identifier: `ENG-${number}`,
  title: `Issue ${number}`,
  url: `https://team.atlassian.net/browse/ENG-${number}`,
  site: "https://team.atlassian.net",
  repo: "",
  projectPath: "",
  labels: [],
  assignees: [],
  state: "open",
  updatedAt: "",
  draft: false,
  ...over,
});

const edge = (
  key: string,
  label: string,
  target: InboxItem | null,
  over: Partial<InboxRelationEdge> = {},
): InboxRelationEdge => ({
  key,
  label,
  ref: target?.identifier ?? over.ref ?? "",
  item: target,
  ...over,
});

describe("groupInboxRelations", () => {
  it("orders canonical groups and keeps provider labels inside them", () => {
    const groups = groupInboxRelations(item(1), [
      edge("related", "relates to", item(5)),
      edge("parent", "Parent", item(2)),
      edge("blocked-by", "is blocked by", item(4)),
      edge("children", "Sub-task", item(3)),
      edge("blocks", "blocks", item(6)),
      edge("duplicate", "duplicates", item(7)),
    ]);
    expect(groups.map((group) => group.key)).toEqual([
      "parent",
      "children",
      "blocks",
      "blocked-by",
      "related",
      "duplicate",
    ]);
    expect(groups[0].label).toBe("Parent");
    expect(groups[4].edges[0].label).toBe("relates to");
  });

  it("drops self-links and dedupes repeated targets per group", () => {
    const groups = groupInboxRelations(item(1), [
      edge("related", "relates to", item(1)),
      edge("related", "relates to", item(2)),
      edge("related", "relates to", item(2)),
      edge("blocks", "blocks", item(2)),
    ]);
    const related = groups.find((group) => group.key === "related");
    expect(related?.edges).toHaveLength(1);
    expect(groups.find((group) => group.key === "blocks")?.edges).toHaveLength(
      1,
    );
  });

  it("keeps ref-only edges and orders custom groups last", () => {
    const groups = groupInboxRelations(item(1), [
      edge("custom-b", "mirrors", null, { ref: "EXT-9" }),
      edge("related", "relates to", item(2)),
      edge("custom-a", "causes", null, { ref: "EXT-8" }),
    ]);
    expect(groups.map((group) => group.key)).toEqual([
      "related",
      "custom-a",
      "custom-b",
    ]);
    const custom = groups[1].edges[0];
    expect(custom.item).toBeNull();
    expect(custom.label).toBe("causes");
    expect(groups[1].label).toBe("causes");
  });

  it("treats an empty key as related and skips empty edges", () => {
    const groups = groupInboxRelations(item(1), [
      edge("", "linked", item(2)),
      edge("related", "", null),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].key).toBe("related");
    expect(groups[0].edges).toHaveLength(1);
  });
});
