// @vitest-environment happy-dom
import { act, createElement, StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const spawnPty = vi.fn();
  const writePty = vi.fn();
  const getPtyStatus = vi.fn();
  const killPty = vi.fn();
  const resizePty = vi.fn();
  const subscribePty = vi.fn(() => () => {});
  return { spawnPty, writePty, getPtyStatus, killPty, resizePty, subscribePty };
});

vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    options: Record<string, unknown>;
    cols = 80;
    rows = 24;
    buffer = {
      active: { type: "normal" },
      onBufferChange: () => ({ dispose() {} }),
    };
    parser = { registerOscHandler: () => ({ dispose() {} }) };
    element = null;
    constructor(options: Record<string, unknown>) {
      this.options = options;
    }
    open() {}
    dispose() {}
    write() {}
    writeln() {}
    onData() {
      return { dispose() {} };
    }
    onRender() {
      return { dispose() {} };
    }
    attachCustomKeyEventHandler() {}
    attachCustomWheelEventHandler() {}
    hasSelection() {
      return false;
    }
    getSelection() {
      return "";
    }
    paste() {}
    focus() {}
  },
}));
vi.mock("@xterm/xterm/css/xterm.css", () => ({}));
vi.mock("../lib/pty", () => ({
  spawnPty: mocks.spawnPty,
  writePty: mocks.writePty,
  getPtyStatus: mocks.getPtyStatus,
  killPty: mocks.killPty,
  resizePty: mocks.resizePty,
  subscribePty: mocks.subscribePty,
}));
vi.mock("../lib/terminalLayout", () => ({
  applyTerminalChrome: vi.fn(),
  fitTerminal: vi.fn(() => null),
  resetGridStretch: vi.fn(),
}));
vi.mock("../lib/appearance", () => ({
  isLightScheme: () => false,
  SCHEME_CHANGE_EVENT: "scheme",
}));

import { TerminalView } from "./TerminalView";
import type { TerminalCommand } from "../lib/layout";

const command = (overrides: Partial<TerminalCommand> = {}): TerminalCommand => ({
  presetId: "cmd1",
  name: "Dev",
  text: "npm run dev",
  runId: 1,
  ...overrides,
});

function render(commandProp?: TerminalCommand) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const onMetaChange = vi.fn();
  const run = (cmd?: TerminalCommand) =>
    root.render(
      createElement(TerminalView, {
        id: "t1",
        cwd: "/repo",
        active: true,
        command: cmd ?? commandProp,
        onMetaChange,
      }),
    );
  return { host, root, onMetaChange, run };
}

const flush = async () => {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
};

describe("TerminalView bound commands", () => {
  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal("ResizeObserver", class {
      observe() {}
      disconnect() {}
    });
    mocks.spawnPty.mockResolvedValue(undefined);
    mocks.writePty.mockResolvedValue(undefined);
    mocks.getPtyStatus.mockResolvedValue({ foreground: null });
    mocks.killPty.mockResolvedValue(undefined);
    mocks.resizePty.mockResolvedValue(undefined);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("writes the command once the PTY is spawned and marks it launched", async () => {
    const { host, root, onMetaChange, run } = render(command());
    await act(async () => run());
    await flush();
    expect(mocks.spawnPty).toHaveBeenCalledWith(
      "t1",
      "/repo",
      expect.any(Number),
      expect.any(Number),
    );
    expect(mocks.writePty).toHaveBeenCalledWith("t1", "npm run dev\r");
    expect(onMetaChange).toHaveBeenCalledWith({ command: { launched: 1 } });
    await act(async () => root.unmount());
    host.remove();
  });

  it("does not write a command that was already launched", async () => {
    const { host, root, run } = render(command({ runId: 1, launched: 1 }));
    await act(async () => run());
    await flush();
    expect(mocks.writePty).not.toHaveBeenCalled();
    await act(async () => root.unmount());
    host.remove();
  });

  it("re-fires with fresh text when runId bumps on a live terminal", async () => {
    const { host, root, run } = render(command({ runId: 1, launched: 1 }));
    await act(async () => run());
    await flush();
    expect(mocks.writePty).not.toHaveBeenCalled();
    await act(async () =>
      run(command({ runId: 2, launched: 1, text: "npm run build" })),
    );
    await flush();
    expect(mocks.writePty).toHaveBeenCalledWith("t1", "npm run build\r");
    await act(async () => root.unmount());
    host.remove();
  });

  it("does not mark a command launched when the write fails", async () => {
    mocks.writePty.mockRejectedValue(new Error("Terminal is not running"));
    const { host, root, onMetaChange, run } = render(command());
    await act(async () => run());
    await flush();
    expect(mocks.writePty).toHaveBeenCalledWith("t1", "npm run dev\r");
    expect(onMetaChange).not.toHaveBeenCalledWith(
      expect.objectContaining({ command: expect.anything() }),
    );
    await act(async () => root.unmount());
    host.remove();
  });

  it("survives a StrictMode remount — the stale cleanup must not kill the new PTY", async () => {
    // First spawn resolves after the remount's spawn was issued, mirroring the
    // real invoke ordering: the ghost cleanup then fired killPty for the id,
    // terminating the live replacement and leaving a dead terminal.
    const resolvers: (() => void)[] = [];
    mocks.spawnPty.mockImplementation(
      () => new Promise<void>((resolve) => resolvers.push(resolve)),
    );
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const onMetaChange = vi.fn();
    await act(async () =>
      root.render(
        createElement(
          StrictMode,
          null,
          createElement(TerminalView, {
            id: "t1",
            cwd: "/repo",
            active: true,
            command: command(),
            onMetaChange,
          }),
        ),
      ),
    );
    expect(mocks.spawnPty).toHaveBeenCalledTimes(2);
    // Ghost spawn resolves late; the remount's spawn follows.
    await act(async () => {
      resolvers[0]?.();
      await Promise.resolve();
    });
    await act(async () => {
      resolvers[1]?.();
      await Promise.resolve();
    });
    await flush();
    expect(mocks.killPty).not.toHaveBeenCalled();
    expect(mocks.writePty).toHaveBeenCalledWith("t1", "npm run dev\r");
    expect(onMetaChange).toHaveBeenCalledWith({ command: { launched: 1 } });
    await act(async () => root.unmount());
    await flush();
    expect(mocks.killPty).toHaveBeenCalledTimes(1);
    host.remove();
  });
});
