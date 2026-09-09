import { expect, it, vi } from "vitest";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

it("keeps native and distribution probes separate, coalesces requests and refreshes failures", async () => {
  const { registerBuiltinHarnesses } = await import("./register");
  registerBuiltinHarnesses();
  const {
    probeHarnessAvailability,
    isHarnessAvailable,
    hasProbedHarnessAvailability,
  } = await import("./availability");
  const cwd = "//wsl.localhost/Ubuntu/home/me/Zażółć repo";
  const other = "//wsl.localhost/Debian/home/me/repo";
  invoke.mockImplementation(async (command, args) => {
    if (command === "wsl_resolve_harness") {
      if (args.cwd === cwd && args.provider === "codex")
        return { path: "/usr/bin/codex" };
      throw new Error("CLI unavailable in distribution");
    }
    return { path: "C:/bin/agent.exe" };
  });
  await probeHarnessAvailability();
  expect(isHarnessAvailable("codex")).toBe(true);
  expect(isHarnessAvailable("codex", cwd)).toBe(false);
  expect(hasProbedHarnessAvailability(cwd)).toBe(false);
  const first = probeHarnessAvailability({ cwd });
  expect(probeHarnessAvailability({ cwd })).toBe(first);
  await first;
  expect(isHarnessAvailable("codex", cwd)).toBe(true);
  expect(isHarnessAvailable("claude", cwd)).toBe(false);
  expect(isHarnessAvailable("codex", other)).toBe(false);
  const count = invoke.mock.calls.length;
  await probeHarnessAvailability({ cwd: "//wsl$/ubuntu/home/another" });
  expect(invoke).toHaveBeenCalledTimes(count);
  await probeHarnessAvailability({ cwd: other });
  expect(isHarnessAvailable("codex", other)).toBe(false);
  invoke.mockRejectedValue(new Error("Disconnected"));
  await probeHarnessAvailability({ cwd, force: true });
  expect(isHarnessAvailable("codex", cwd)).toBe(false);
  expect(isHarnessAvailable("codex")).toBe(true);
});
