import { hotkeyBlockedByTarget } from "./hotkeyTarget";

type ArchiveContext = {
  activeTabId: string;
  tabs: readonly { id: string; focusedId: string; diffFocused?: boolean }[];
  sessions: readonly { id: string }[];
  projectTerminalFocused: boolean;
  surfaceOpen: boolean;
};

/** Archive only after confirming that the focused conversation owns the key. */
export function archiveFocusedSession(
  event: KeyboardEvent,
  context: ArchiveContext,
  archive: (sessionId: string) => void,
): void {
  if (
    event.defaultPrevented ||
    context.projectTerminalFocused ||
    context.surfaceOpen
  )
    return;

  const tab = context.tabs.find((entry) => entry.id === context.activeTabId);
  if (!tab || tab.diffFocused) return;
  const session = context.sessions.find((entry) => entry.id === tab.focusedId);
  if (!session) return;

  if (hotkeyBlockedByTarget(event.target)) return;

  event.preventDefault();
  event.stopPropagation();
  archive(session.id);
}
