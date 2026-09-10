export const ADD_TO_CHAT_EVENT = "monocode:add-to-chat";

export type AddToChatMode = "quote" | "plain";

export type AddToChatRequest = {
  text: string;
  mode: AddToChatMode;
};

export type QuoteRequest = {
  id: number;
  text: string;
  mode?: AddToChatMode;
  origin?: string;
};

export function requestAddToChat(text: string, mode: AddToChatMode = "quote") {
  if (typeof window === "undefined") return;
  const value = text.replace(/\r\n?/g, "\n").trim();
  if (!value) return;
  window.dispatchEvent(
    new CustomEvent<AddToChatRequest>(ADD_TO_CHAT_EVENT, {
      detail: { text: value, mode },
    }),
  );
}

export type QuoteConsumption = {
  draft: string;
  consumedId: number | null;
  changed: boolean;
};

export function isMarkdownBlockquotePosition(
  text: string,
  position: number,
): boolean {
  const index = Math.max(0, Math.min(position, text.length));
  const lineStart = text.lastIndexOf("\n", Math.max(0, index - 1)) + 1;
  return /^ {0,3}>/.test(text.slice(lineStart, index));
}

export function appendSelectionQuote(draft: string, text: string, origin?: string): string {
  const normalized = text.replace(/\r\n?/g, "\n").trim();
  const selected =
    normalized.slice(0, 32_000) +
    (normalized.length > 32_000
      ? "\n[Selected context truncated at 32,000 characters]"
      : "");
  if (!selected) return draft;

  const quote = selected
    .split("\n")
    .map((line) => (line ? `> ${line}` : ">"))
    .join("\n");
  return joinComposerInsert(draft, origin ? `${quote}\n\nSource: ${origin.slice(0, 2000).replace(/[\r\n]+/g, " ")}` : quote);
}

export function appendComposerInsert(draft: string, text: string): string {
  const normalized = text.replace(/\r\n?/g, "\n").trim();
  const selected =
    normalized.slice(0, 32_000) +
    (normalized.length > 32_000
      ? "\n[Selected context truncated at 32,000 characters]"
      : "");
  if (!selected) return draft;
  return joinComposerInsert(draft, selected);
}

export function consumeQuoteRequest(
  draft: string,
  consumedId: number | null,
  request: QuoteRequest | undefined,
): QuoteConsumption {
  if (!request || request.id === consumedId) {
    return { draft, consumedId, changed: false };
  }

  const next =
    request.mode === "plain"
      ? appendComposerInsert(draft, request.text)
      : appendSelectionQuote(draft, request.text, request.origin);
  return {
    draft: next,
    consumedId: request.id,
    changed: next !== draft,
  };
}

export function acknowledgeQuoteRequest(
  current: QuoteRequest | undefined,
  handledId: number,
): QuoteRequest | undefined {
  return current?.id === handledId ? undefined : current;
}

function joinComposerInsert(draft: string, block: string): string {
  const separator =
    draft.length === 0
      ? ""
      : draft.endsWith("\n\n")
        ? ""
        : draft.endsWith("\n")
          ? "\n"
          : "\n\n";
  return `${draft}${separator}${block}\n\n`;
}
