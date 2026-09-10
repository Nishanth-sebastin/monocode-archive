export type EditorCodeSelection = {
  path: string;
  startLine: number;
  endLine: number;
};

/** Turn an editor range into a compact reference the agent can read on demand. */
export function formatEditorSelectionReference({
  path,
  startLine,
  endLine,
}: EditorCodeSelection): string {
  const file = formatFileReference(path);
  const lines =
    startLine === endLine
      ? `line ${startLine}`
      : `lines ${startLine}-${endLine}`;
  return `${file} (${lines})`;
}

function formatFileReference(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  if (isMentionablePath(normalized)) return `@${normalized}`;
  return `\`${normalized.replace(/[`\r\n]/g, "'")}\``;
}

function isMentionablePath(path: string): boolean {
  if (!path || path.length > 120 || path.startsWith("/")) return false;
  if (/\s|@|[\u0000-\u001f\u007f-\u009f]/.test(path)) return false;
  return path.split("/").every((part) => part && part !== "." && part !== "..");
}

const LANGUAGE_FROM_EXT: Record<string, string> = {
  sh: "bash",
  zsh: "bash",
  py: "python",
  rb: "ruby",
  rs: "rust",
  ts: "typescript",
  js: "javascript",
  md: "markdown",
  yml: "yaml",
  cs: "csharp",
  cpp: "cpp",
  cc: "cpp",
  cxx: "cpp",
};

export function languageFromFileName(fileName: string): string {
  const lower = fileName.split(/[/\\]/).pop()!.toLowerCase();
  if (lower === "dockerfile") return "dockerfile";
  if (lower === "makefile") return "makefile";
  const ext = lower.includes(".")
    ? lower.slice(lower.lastIndexOf(".") + 1)
    : lower;
  return LANGUAGE_FROM_EXT[ext] ?? ext;
}

export function formatCodeBlock(text: string, language: string): string {
  let length = 3;
  for (const match of text.matchAll(/`+/g)) length = Math.max(length, match[0].length + 1);
  const fence = "`".repeat(length);
  return `${fence}${language.replace(/[^a-z0-9_+.-]/gi, "")}\n${text}\n${fence}`;
}

export function formatEditorSelectionContext(selection: EditorCodeSelection & { text?: string }): string {
  const reference = formatEditorSelectionReference(selection);
  if (!selection.text) return reference;
  const text = selection.text.slice(0, 30_000);
  return `${reference}\n\n${formatCodeBlock(text, languageFromFileName(selection.path))}${text.length < selection.text.length ? "\n\n[Selected context truncated]" : ""}`;
}
