// @vitest-environment happy-dom
import { beforeEach, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { attachmentsFromFiles } from "./attachments";
import {
  contextChoices,
  DEFAULT_CONTEXT,
  prepareContext,
  selectedContext,
  type ContextDocument,
} from "./inboxContext";
import { composeInboxMessage, type InboxItem } from "./githubTasks";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("./attachments", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  attachmentsFromFiles: vi.fn(async (files: File[]) =>
    files.map((file, index) => ({
      id: String(index),
      name: file.name,
      mimeType: file.type,
      size: file.size,
      kind: "file",
      path: `/tmp/${index}`,
    })),
  ),
}));

const item = (provider: InboxItem["provider"]): InboxItem => ({
  provider,
  kind: "issue",
  id: "1",
  number: 1,
  identifier: "ENG-1",
  title: "Context test",
  url: `https://${provider}.example/team/issues/1`,
  repo: "team/project",
  projectPath: "/local/project",
  labels: [],
  assignees: [],
  state: "open",
  updatedAt: "",
  draft: false,
});
const comment = (id: string, body: string) => ({
  id,
  body,
  author: "Ada",
  createdAt: "2026-09-10",
  updatedAt: "2026-09-10",
});
const file = (id: string, size = 4) => ({
  id,
  name: "same-name.txt",
  mimeType: "text/plain",
  size,
  url: `https://files.example/${id}`,
  unavailable: null,
});
const document: ContextDocument = {
  owner: "account:1",
  description: "Selected requirements",
  comments: [
    comment("one", "Selected comment"),
    comment("two", "Excluded comment"),
  ],
  files: [file("one"), file("two")],
  more: false,
};

beforeEach(() => {
  const stored = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => stored.get(key) ?? null,
    setItem: (key: string, value: string) => stored.set(key, value),
  });
  vi.clearAllMocks();
  vi.mocked(invoke).mockImplementation(async (command) =>
    command === "inbox_context_document"
      ? structuredClone(document)
      : {
          data: "dGVzdA==",
          name: "same-name.txt",
          mimeType: "text/plain",
          size: 4,
        },
  );
});

it.each(["github", "gitlab", "linear", "jira"] as const)(
  "%s uses only selected text and files in a frozen one-shot card",
  async (provider) => {
    const ticket = item(provider);
    const choices = { description: false, comments: ["one"], files: ["two"] };
    const card = await prepareContext(ticket, document, choices, 1);
    expect(card.prompt).toContain("Selected comment");
    expect(card.prompt).not.toContain("Excluded comment");
    expect(card.prompt).not.toContain("Selected requirements");
    expect(card.attachments).toHaveLength(1);
    expect(invoke).toHaveBeenCalledWith(
      "inbox_context_download",
      expect.objectContaining({
        fileId: "two",
        owner: "account:1",
        ticket: expect.objectContaining({ provider }),
      }),
    );
    choices.comments.push("two");
    expect(card.prompt).not.toContain("Excluded comment");
    expect(composeInboxMessage(card, "My question")).toContain("My question");
    expect(composeInboxMessage(undefined, "Follow-up")).toBe("Follow-up");
    expect(card.contextPreview?.comments.map((c) => c.id)).toEqual(["one"]);
  },
);

it("shares saved settings between actions, isolates accounts/tickets and saves no content", () => {
  const choices = {
    description: false,
    comments: ["one"],
    files: ["two"],
    pages: 3,
  };
  contextChoices("account:1", item("jira").url, choices);
  expect(contextChoices("account:1", item("jira").url)).toEqual(choices);
  expect(contextChoices("account:2", item("jira").url)).toEqual(
    DEFAULT_CONTEXT,
  );
  expect(contextChoices("account:1", item("github").url)).toEqual(
    DEFAULT_CONTEXT,
  );
  expect(localStorage.getItem("monocode.inboxContextChoices")).not.toContain(
    "Selected comment",
  );
  localStorage.setItem("monocode.inboxContextChoices", "invalid");
  expect(contextChoices("account:1", item("jira").url)).toEqual(
    DEFAULT_CONTEXT,
  );
});

it("blocks deleted selections and size limits without silently dropping items", () => {
  expect(() =>
    selectedContext(item("jira"), document, {
      ...DEFAULT_CONTEXT,
      comments: ["deleted"],
    }),
  ).toThrow("unavailable");
  expect(() =>
    selectedContext(item("jira"), document, {
      ...DEFAULT_CONTEXT,
      files: ["deleted"],
    }),
  ).toThrow("unavailable");
  const large = { ...document, files: [file("big", 21 * 1024 * 1024)] };
  expect(() =>
    selectedContext(item("jira"), large, {
      ...DEFAULT_CONTEXT,
      files: ["big"],
    }),
  ).toThrow("20 MiB");
  expect(() =>
    selectedContext(
      item("jira"),
      { ...document, description: "a".repeat(100_001) },
      DEFAULT_CONTEXT,
    ),
  ).toThrow("100,000");
});

it("requires review after account/text changes and does not download excluded files", async () => {
  vi.mocked(invoke).mockResolvedValueOnce({ ...document, owner: "account:2" });
  await expect(
    prepareContext(item("jira"), document, DEFAULT_CONTEXT, 1),
  ).rejects.toThrow("changed");
  expect(attachmentsFromFiles).not.toHaveBeenCalled();
  vi.mocked(invoke).mockResolvedValueOnce({
    ...document,
    description: "Changed requirements",
  });
  await expect(
    prepareContext(item("jira"), document, DEFAULT_CONTEXT, 1),
  ).rejects.toThrow("changed");
  await prepareContext(item("jira"), document, DEFAULT_CONTEXT, 1);
  expect(
    vi
      .mocked(invoke)
      .mock.calls.every(([cmd]) => cmd === "inbox_context_document"),
  ).toBe(true);
});

it("retains choices on partial failure and keeps duplicate file names distinct", async () => {
  const choices = { ...DEFAULT_CONTEXT, files: ["one", "two"] };
  vi.mocked(invoke)
    .mockImplementationOnce(async () => document)
    .mockRejectedValueOnce(new Error("Permission denied"));
  await expect(
    prepareContext(item("jira"), document, choices, 1),
  ).rejects.toThrow("Permission denied");
  expect(choices.files).toEqual(["one", "two"]);
  const card = await prepareContext(item("jira"), document, choices, 1);
  expect(card.attachments).toHaveLength(2);
  expect(new Set(card.attachments?.map((f) => f.id)).size).toBe(2);
  vi.mocked(attachmentsFromFiles).mockResolvedValueOnce([]);
  await expect(
    prepareContext(item("jira"), document, choices, 1),
  ).rejects.toThrow("every selected file");
});
