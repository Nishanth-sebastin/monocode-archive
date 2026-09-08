import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");

describe("fork distribution boundary", () => {
  it("keeps packaged identity, local data namespace and macOS dev identity aligned", () => {
    const config = JSON.parse(read("src-tauri/tauri.conf.json"));
    expect(config.identifier).toBe("com.kaceper11.monocode");
    expect(config.productName).toBe("MonoCode Fork");
    expect(config.app.windows[0].title).toBe(config.productName);
    const macos = read("src-tauri/src/macos.rs");
    expect(macos).toContain(`const DEV_BUNDLE_ID: &str = "${config.identifier}"`);
    expect(macos).toContain(`<string>${config.identifier}</string>`);
    expect(macos).toContain(`.join("${config.productName}.app")`);
    expect(macos).not.toContain("com.monocode.desktop");
  });

  it("leaves updater endpoints and release jobs inactive for this fork", () => {
    const config = JSON.parse(read("src-tauri/tauri.conf.json"));
    expect(config.plugins.updater.endpoints).toEqual([]);
    expect(config.plugins.updater.pubkey).toBe("");
    expect(config.bundle.createUpdaterArtifacts).toBe(false);
    const workflow = read(".github/workflows/release.yml");
    for (const job of ["release", "linux", "windows"]) {
      const start = workflow.indexOf(`\n  ${job}:\n`);
      expect(start).toBeGreaterThan(-1);
      const next = workflow.slice(start + 1).search(/\n  [\w-]+:\n/);
      const block = next < 0 ? workflow.slice(start) : workflow.slice(start, start + 1 + next);
      expect(block).toContain("if: github.repository == 'hardbeat920/monocode'");
    }
  });
});
