import { invoke } from "@tauri-apps/api/core";
import { beforeEach, expect, it, vi } from "vitest";
import { connectWslProject } from "./wsl";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
beforeEach(() => {
  vi.mocked(invoke).mockReset();
});

it("opens only the selected distribution and preserves cancellation and errors", async () => {
  const path = "//wsl.localhost/Ubuntu Work/home/me/Zażółć Repo";
  vi.mocked(invoke).mockResolvedValue({
    distribution: "Ubuntu Work",
    path: "/real/Zażółć Repo",
  });
  await expect(connectWslProject(path)).resolves.toBe(
    "//wsl.localhost/Ubuntu Work/real/Zażółć Repo",
  );
  expect(invoke).toHaveBeenCalledWith("wsl_connect", {
    distribution: "Ubuntu Work",
    path: "/home/me/Zażółć Repo",
  });
  vi.mocked(invoke).mockResolvedValue({
    distribution: "Debian",
    path: "/real/project",
  });
  await expect(connectWslProject(path)).rejects.toThrow(
    "different distribution",
  );
  vi.mocked(invoke).mockRejectedValue(new Error("Distribution stopped"));
  await expect(connectWslProject(path)).rejects.toThrow("Distribution stopped");
  vi.mocked(invoke).mockResolvedValue({
    distribution: "Ubuntu Work",
    path: "/real/project",
  });
  await expect(connectWslProject(path)).resolves.toBe(
    "//wsl.localhost/Ubuntu Work/real/project",
  );
  const controller = new AbortController();
  let finish!: (value: unknown) => void;
  vi.mocked(invoke).mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const pending = connectWslProject(path, controller.signal);
  controller.abort();
  finish({ distribution: "Ubuntu Work", path: "/late/project" });
  await expect(pending).rejects.toThrow();
  vi.mocked(invoke).mockClear();
  await expect(connectWslProject(path, controller.signal)).rejects.toThrow();
  await expect(connectWslProject("C:/native/project")).rejects.toThrow(
    "WSL distribution",
  );
  expect(invoke).not.toHaveBeenCalled();
});
