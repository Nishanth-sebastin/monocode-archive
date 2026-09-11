// @vitest-environment happy-dom
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { openUrl } from "@tauri-apps/plugin-opener";
import { gitPrStatus } from "./fs";
import { deliveryProvider, saveDeliveryProvider, repositoryProvider, openGitHubDelivery } from "./deliveryProviders";
vi.mock("@tauri-apps/plugin-opener", () => ({openUrl: vi.fn()}));
vi.mock("./fs", () => ({gitPrStatus: vi.fn()}));
beforeEach(() => { const rows = new Map<string, string>(); vi.stubGlobal("localStorage", {getItem:(key:string) => rows.get(key) ?? null, setItem:(key:string,value:string) => rows.set(key,value)}); });
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });
it("resolves known remotes without choosing between ambiguous providers", () => {
  const github = {name:"origin", url:"git@github.com:team/repo.git"};
  const azure = {name:"azure", url:"https://dev.azure.com/team/project/_git/repo"};
  expect(repositoryProvider([github])).toBe("github");
  expect(repositoryProvider([azure])).toBe("azure");
  expect(repositoryProvider([github, azure])).toBeUndefined();
  expect(repositoryProvider([github, azure], "azure")).toBe("azure");
  expect(repositoryProvider([{name:"origin", url:"https://github.com.evil.test/a/b"}])).toBeUndefined();
});
it("keeps PR and CI choices scoped to checkout, branch and conversation", () => {
  saveDeliveryProvider("/repo", "feature", "owner", "pr", "github");
  saveDeliveryProvider("/repo", "feature", "owner", "ci", "azure");
  expect(deliveryProvider("/repo", "feature", "owner", "pr")).toBe("github");
  expect(deliveryProvider("/repo", "feature", "owner", "ci")).toBe("azure");
  expect(deliveryProvider("/repo", "other", "owner", "ci")).toBeUndefined();
  expect(deliveryProvider("/repo", "feature", "other", "ci")).toBeUndefined();
  saveDeliveryProvider("/repo", "feature", "owner", "ci", "");
  expect(deliveryProvider("/repo", "feature", "owner", "ci")).toBeUndefined();
});
it("opens the selected GitHub PR/checks and discards stale navigation", async () => {
  vi.mocked(gitPrStatus).mockResolvedValue({number:3,title:"Fix",state:"OPEN",url:"https://github.com/team/repo/pull/3?tab=files"});
  await openGitHubDelivery("/repo", "ci", () => true);
  expect(openUrl).toHaveBeenCalledWith("https://github.com/team/repo/pull/3/checks");
  vi.mocked(openUrl).mockClear();
  await openGitHubDelivery("/repo", "pr", () => false);
  expect(openUrl).not.toHaveBeenCalled();
  await expect(openGitHubDelivery("/repo", "pr", () => true, "javascript:alert(1)")).rejects.toThrow("invalid PR link");
});
