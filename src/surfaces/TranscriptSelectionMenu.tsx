import { useEffect, useRef } from "react";
import { ExplorerMenu } from "../chrome/ExplorerMenu";
import { type TranscriptSelection } from "../lib/transcriptSelection";

type Props = {
  selection: TranscriptSelection | null;
  onAddToChat: (text: string, responseId?: string) => void;
  onDismiss: () => void;
  onSendToAgent?: (text: string, responseId?: string) => void;
};

export function TranscriptSelectionMenu({
  selection,
  onAddToChat,
  onDismiss,
  onSendToAgent,
}: Props) {
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
    <ExplorerMenu
      x={selection.rect.left}
      y={selection.rect.bottom + 6}
      width={180}
      ariaLabel="Selected text actions"
      items={[
        { kind: "item", id: "add", label: "Add to chat" },
        ...(onSendToAgent ? [{ kind: "item" as const, id: "send", label: "Send to agent…" }] : []),
      ]}
      onPick={(id) => {
        if (id === "add") onAddToChat(selection.text, selection.responseId);
        else onSendToAgent?.(selection.text, selection.responseId);
        window.getSelection()?.removeAllRanges();
        onDismiss();
      }}
      onClose={onDismiss}
    />
  );
}
