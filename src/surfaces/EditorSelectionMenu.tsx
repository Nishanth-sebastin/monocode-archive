import { contextFromText, requestAgentContext } from "../lib/agentContext";
import { useEffect, useRef } from "react";
import { ExplorerMenu } from "../chrome/ExplorerMenu";
import {
  formatEditorSelectionContext,
  type EditorCodeSelection,
} from "../lib/editorSelection";
import { requestAddToChat } from "../lib/quoteDraft";

export type EditorSelectionTarget = EditorCodeSelection & {
  anchor: DOMRect;
  text?: string;
  sourcePath?: string;
};

export function EditorSelectionMenu({
  selection,
  onDismiss,
}: {
  selection: EditorSelectionTarget | null;
  onDismiss: () => void;
}) {
  const onDismissRef = useRef(onDismiss);
  onDismissRef.current = onDismiss;

  // A rect captured from CodeMirror is in viewport coordinates. Once the
  // editor moves, dismiss the action instead of leaving it over stale text.
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
      x={selection.anchor.left}
      y={selection.anchor.bottom + 6}
      width={180}
      ariaLabel="Selected code actions"
      items={[
        { kind: "item", id: "add", label: "Add to chat" },
        { kind: "item", id: "send", label: "Send to agent…" },
      ]}
      onPick={(id) => {
        const path = selection.sourcePath ?? selection.path;
        const text = formatEditorSelectionContext({ ...selection, path });
        if (id === "add") requestAddToChat(text, "plain");
        else requestAgentContext({ context: contextFromText("Selected file lines", text, path) });
        onDismiss();
      }}
      onClose={onDismiss}
    />
  );
}
