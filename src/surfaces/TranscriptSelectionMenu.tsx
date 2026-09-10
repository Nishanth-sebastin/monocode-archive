import { MessageSquarePlus, MoreHorizontal } from "../chrome/icons";
import { useEffect, useRef, useState } from "react";
import { Popover } from "../chrome/Popover";
import { type TranscriptSelection } from "../lib/transcriptSelection";

type Props = {
  selection: TranscriptSelection | null;
  onAddToChat: (text: string) => void;
  onDismiss: () => void;
  onSendToAgent?: (text: string, responseId?: string) => void;
};

export function TranscriptSelectionMenu({
  selection,
  onAddToChat,
  onDismiss,
  onSendToAgent,
}: Props) {
  const [more, setMore] = useState(false);
  const onDismissRef = useRef(onDismiss);
  onDismissRef.current = onDismiss;

  // Scrolling or resizing moves the text out from under the menu, so the
  // selection it acts on is gone; drop it rather than chase the range.
  useEffect(() => {
    if (!selection) return;
    const dismiss = () => onDismissRef.current();
    window.addEventListener("scroll", dismiss, true);
    window.addEventListener("resize", dismiss);
    return () => {
      window.removeEventListener("scroll", dismiss, true);
      window.removeEventListener("resize", dismiss);
    };
  }, [selection]);

  if (!selection) return null;

  return (
    <Popover
      anchor={selection.rect}
      side="top"
      align="center"
      onDismiss={(reason) => {
        if (reason === "escape") window.getSelection()?.removeAllRanges();
        onDismiss();
      }}
      role="toolbar"
      aria-label="Selected text actions"
      className="flex p-1"
    >
      <button
        type="button"
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => {
          onAddToChat(selection.text);
          window.getSelection()?.removeAllRanges();
          onDismiss();
        }}
        className="flex h-7 items-center gap-1.5 rounded-lg px-2 font-sans text-[13px] leading-none text-content outline-none ring-accent/40 hover:bg-content/5 focus-visible:ring-2"
      >
        <MessageSquarePlus
          aria-hidden="true"
          className="size-3.5"
          strokeWidth={1.75}
        />
        Add to chat
      </button>
      {onSendToAgent ? (
        <>
          <button
            type="button"
            aria-label="More selected text actions"
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => setMore((value) => !value)}
            className="rounded px-1 hover:bg-content/5"
          >
            <MoreHorizontal className="size-4" />
          </button>
          {more ? (
            <button
              type="button"
              className="rounded px-2 text-[12px] hover:bg-content/5"
              onMouseDown={(event) => event.preventDefault()}
              onClick={() =>
                onSendToAgent(selection.text, selection.responseId)
              }
            >
              Send to another agent…
            </button>
          ) : null}
        </>
      ) : null}
    </Popover>
  );
}
