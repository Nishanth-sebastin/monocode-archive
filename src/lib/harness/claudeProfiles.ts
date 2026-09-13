import type { ModelSettingChoice } from "../models";

/**
 * Per-account Claude Code identities, mirroring the `claudo`/`claudd`/`claudz`
 * shell functions in ~/.zshrc (each sets CLAUDE_CONFIG_DIR to a different
 * account's config dir). MonoCode has no notion of this on its own — it
 * always resolves and spawns a single `claude` binary — so this is threaded
 * through explicitly from the model-settings picker down to `harness_spawn`.
 */
export type ClaudeProfileId = "personal" | "dharani" | "office2";

export type ClaudeProfile = {
  id: ClaudeProfileId;
  label: string;
  /** Relative to $HOME, matching the zshrc CLAUDE_CONFIG_DIR values. */
  configDirName: string;
};

export const CLAUDE_PROFILES: ClaudeProfile[] = [
  { id: "personal", label: "Personal", configDirName: ".claude-personal" },
  { id: "dharani", label: "Dharani", configDirName: ".claude-dharani" },
  { id: "office2", label: "Office2", configDirName: ".claude-office2" },
];

export const CLAUDE_PROFILE_DEFAULT: ClaudeProfileId = "personal";

export const CLAUDE_PROFILE_OPTIONS: ModelSettingChoice[] = CLAUDE_PROFILES.map(
  (profile) => ({ value: profile.id, label: profile.label }),
);

/**
 * Folder-based guardrail: which profiles a project's cwd is allowed to
 * launch under, independent of what the picker has selected. Projects under
 * `yuko` are client work that must never run under the `dharani` account;
 * everything else (e.g. `personal`) is unrestricted.
 */
function allowedProfileIds(cwd: string): ClaudeProfileId[] {
  const normalized = cwd.replace(/\\/g, "/");
  if (/\/yuko(?:[-_][a-z0-9]+)*(?:\/|$)/i.test(normalized)) {
    return ["personal", "office2"];
  }
  return ["personal", "dharani", "office2"];
}

export function claudeProfileOptionsFor(cwd: string): ModelSettingChoice[] {
  const allowed = new Set(allowedProfileIds(cwd));
  return CLAUDE_PROFILE_OPTIONS.filter((option) => allowed.has(option.value as ClaudeProfileId));
}

/**
 * Resolves the requested profile against the folder allow-list for `cwd`
 * and returns the env to launch `claude` with. A disallowed request (e.g.
 * "dharani" picked while cwd is under yuko/) is silently corrected to the
 * folder's first allowed profile rather than launching under the wrong
 * account — callers should surface `warning` to the user when present.
 */
export function resolveClaudeProfileEnv(
  requestedId: string | undefined,
  cwd: string,
  home: string,
): { env: Record<string, string>; profileId: ClaudeProfileId; warning?: string } {
  const allowed = allowedProfileIds(cwd);
  const requested = (requestedId ?? CLAUDE_PROFILE_DEFAULT) as ClaudeProfileId;
  const profileId = allowed.includes(requested) ? requested : allowed[0];
  const profile =
    CLAUDE_PROFILES.find((candidate) => candidate.id === profileId) ?? CLAUDE_PROFILES[0];
  const env = { CLAUDE_CONFIG_DIR: `${home.replace(/\/+$/, "")}/${profile.configDirName}` };
  if (requestedId && profileId !== requestedId) {
    return {
      env,
      profileId,
      warning: `"${requestedId}" isn't allowed for this project — using "${profileId}" instead.`,
    };
  }
  return { env, profileId };
}
