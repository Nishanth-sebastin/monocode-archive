// @vitest-environment happy-dom
import { beforeEach, expect, it } from "vitest";
import {
  attentionStoreFromSnapshot,
  attentionSnapshot,
  dismissAttention,
  emitAttention,
  emittedAttention,
  isAttentionMuted,
  removeAttention,
  resolveAttention,
  resolveAttentionWhere,
  snoozeAttention,
  visibleAttention,
  type AttentionItem,
} from "./attention";

const row = (over: Partial<AttentionItem> = {}): AttentionItem => ({
  key: "watcher:w1:cond-1",
  kind: "ticket",
  title: "ENG-1 — Fix login",
  urgency: 1,
  at: 1000,
  signature: "sig-a",
  ...over,
});

beforeEach(() => localStorage.clear());

it("emit inserts a row and a replayed signature preserves the timestamp", () => {
  emitAttention(row({ at: 1000 }));
  emitAttention(row({ at: 5000 }));
  const items = emittedAttention();
  expect(items).toHaveLength(1);
  // Same signature → the original `at` stands (no ordering churn).
  expect(items[0].at).toBe(1000);
});

it("a changed signature refreshes the timestamp and resurfaces mutes", () => {
  emitAttention(row({ at: 1000 }));
  snoozeAttention(row().key, "sig-a");
  expect(visibleAttention([], readStore())).toHaveLength(0);
  emitAttention(row({ at: 9000, signature: "sig-b" }));
  const items = visibleAttention([], readStore());
  expect(items).toHaveLength(1);
  expect(items[0].at).toBe(9000);
});

it("dismissed rows stay hidden while the signature is unchanged", () => {
  emitAttention(row());
  dismissAttention(row().key, "sig-a");
  emitAttention(row({ at: 2000 }));
  expect(visibleAttention([], readStore())).toHaveLength(0);
});

it("resolveAttention removes the row and its mute", () => {
  emitAttention(row());
  snoozeAttention(row().key, "sig-a");
  resolveAttention(row().key);
  expect(emittedAttention()).toHaveLength(0);
  expect(readStore().muted[row().key]).toBeUndefined();
});

it("resolveAttentionWhere drops only matching rows", () => {
  emitAttention(row());
  emitAttention(
    row({ key: "watcher:w1:cond-2", title: "Other", signature: "s2" }),
  );
  emitAttention(
    row({ key: "watcher:w2:cond-1", title: "Elsewhere", signature: "s3" }),
  );
  resolveAttentionWhere(
    (item) => item.key.startsWith("watcher:w1:"),
  );
  expect(emittedAttention().map((item) => item.key)).toEqual([
    "watcher:w2:cond-1",
  ]);
});

it("visibleAttention merges derived and emitted rows, emitted winning key collisions", () => {
  const derived = [
    row({ key: "approval:s1:r1", kind: "approval", urgency: 0, title: "Derived" }),
  ];
  emitAttention(
    row({ key: "approval:s1:r1", kind: "approval", urgency: 0, title: "Emitted" }),
  );
  const items = visibleAttention(derived, readStore());
  expect(items).toHaveLength(1);
  expect(items[0].title).toBe("Emitted");
});

it("orders by urgency then recency", () => {
  emitAttention(row({ key: "a", urgency: 2, at: 9000 }));
  emitAttention(row({ key: "b", urgency: 0, at: 100 }));
  emitAttention(row({ key: "c", urgency: 2, at: 10000 }));
  expect(visibleAttention([], readStore()).map((item) => item.key)).toEqual([
    "b",
    "c",
    "a",
  ]);
});

it("malformed persisted rows are dropped, not trusted", () => {
  localStorage.setItem(
    "monocode.attention.v1",
    JSON.stringify({
      items: [
        { key: "", title: "", signature: "", at: 0 },
        { kind: "bogus", key: "k", title: "t", signature: "s", at: 5 },
        null,
        row({ key: "ok" }),
      ],
      muted: { "bad-mute": { signature: "", mode: "dismiss", at: 1 } },
    }),
  );
  const store = readStore();
  // Bogus kinds degrade to "watcher" rather than dropping the row.
  expect(store.items.map((item) => item.key)).toEqual(["k", "ok"]);
  expect(store.items[0].kind).toBe("watcher");
  expect(store.muted["bad-mute"]).toBeUndefined();
});

it("removeAttention deletes the row entirely", () => {
  emitAttention(row());
  removeAttention(row().key);
  expect(emittedAttention()).toHaveLength(0);
});

it("isAttentionMuted binds mute to the current signature", () => {
  const store = {
    items: [],
    muted: { k: { signature: "a", mode: "snooze" as const, at: 1 } },
  };
  expect(
    isAttentionMuted(row({ key: "k", signature: "a" }), store.muted),
  ).toBe(true);
  expect(
    isAttentionMuted(row({ key: "k", signature: "b" }), store.muted),
  ).toBe(false);
});

function readStore() {
  return attentionStoreFromSnapshot(attentionSnapshot());
}
