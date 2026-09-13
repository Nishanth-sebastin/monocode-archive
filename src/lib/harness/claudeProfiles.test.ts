import { describe, expect, it } from "vitest";
import {
  claudeProfileOptionsFor,
  resolveClaudeProfileEnv,
} from "./claudeProfiles";

describe("claudeProfileOptionsFor", () => {
  it("allows all three profiles outside yuko", () => {
    expect(
      claudeProfileOptionsFor("/Users/cartrabbit/Documents/personal/poynt").map(
        (option) => option.value,
      ),
    ).toEqual(["personal", "dharani", "office2"]);
  });

  it("restricts yuko projects to personal and office2", () => {
    expect(
      claudeProfileOptionsFor(
        "/Users/cartrabbit/Documents/yuko/yuko-backend",
      ).map((option) => option.value),
    ).toEqual(["personal", "office2"]);
    expect(
      claudeProfileOptionsFor(
        "/Users/cartrabbit/Documents/yuko/yuko-frontend",
      ).map((option) => option.value),
    ).toEqual(["personal", "office2"]);
  });
});

describe("resolveClaudeProfileEnv", () => {
  const home = "/Users/cartrabbit";

  it("points CLAUDE_CONFIG_DIR at the requested profile when allowed", () => {
    const result = resolveClaudeProfileEnv(
      "office2",
      "/Users/cartrabbit/Documents/yuko/yuko-backend",
      home,
    );
    expect(result.profileId).toBe("office2");
    expect(result.env.CLAUDE_CONFIG_DIR).toBe("/Users/cartrabbit/.claude-office2");
    expect(result.warning).toBeUndefined();
  });

  it("falls back and warns when the requested profile is disallowed for the folder", () => {
    const result = resolveClaudeProfileEnv(
      "dharani",
      "/Users/cartrabbit/Documents/yuko/yuko-frontend",
      home,
    );
    expect(result.profileId).toBe("personal");
    expect(result.env.CLAUDE_CONFIG_DIR).toBe("/Users/cartrabbit/.claude-personal");
    expect(result.warning).toMatch(/not allowed|isn't allowed/);
  });

  it("defaults to personal when no profile was requested", () => {
    const result = resolveClaudeProfileEnv(
      undefined,
      "/Users/cartrabbit/Documents/personal/poynt",
      home,
    );
    expect(result.profileId).toBe("personal");
    expect(result.warning).toBeUndefined();
  });
});
