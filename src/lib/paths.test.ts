import { describe, expect, it } from "vitest";
import {
  displayPath,
  isEqualOrInside,
  joinPath,
  parentPath,
  prettyCwd,
  projectName,
  rebasePath,
  slash,
  pathKey,
  resolveWorkspacePath,
  wslLocation,
  wslPath,
} from "./paths";

describe("WSL identities", () => {
  it("keeps Linux case and distribution identity through aliases, links and rebasing", () => {
    const root = wslPath("Ubuntu Work", "/home/me/Zażółć Repo");
    const alias = "\\\\wsl$\\Ubuntu Work\\home\\me\\Zażółć Repo";
    expect(wslLocation(alias)).toEqual({
      distribution: "Ubuntu Work",
      path: "/home/me/Zażółć Repo",
    });
    expect(pathKey(alias)).toBe(pathKey(root));
    expect(pathKey(root)).not.toBe(pathKey(root.toLowerCase()));
    expect(pathKey(root)).not.toBe(
      pathKey(wslPath("Debian", "/home/me/Zażółć Repo")),
    );
    expect(prettyCwd(root)).toBe("WSL · Ubuntu Work · /home/me/Zażółć Repo");
    expect(resolveWorkspacePath("/home/me/Zażółć Repo/File.ts:12", root)).toBe(
      `${root}/File.ts`,
    );
    expect(
      resolveWorkspacePath(
        "file:///home/me/Za%C5%BC%C3%B3%C5%82%C4%87%20Repo/File.ts",
        root,
      ),
    ).toBe(`${root}/File.ts`);
    expect(resolveWorkspacePath("src/File.ts", root)).toBe(
      `${root}/src/File.ts`,
    );
    expect(
      rebasePath(
        `${alias}\\src\\File.ts`,
        root,
        wslPath("Ubuntu Work", "/worktree"),
      ),
    ).toBe("//wsl.localhost/Ubuntu Work/worktree/src/File.ts");
    expect(isEqualOrInside(`${root}/File.ts`, root.toLowerCase())).toBe(false);
    expect(displayPath(`${alias}\\src\\File.ts`, root)).toBe("src/File.ts");
    expect(parentPath(wslPath("Ubuntu Work", "/"))).toBe(
      "//wsl.localhost/Ubuntu Work",
    );
    expect(() => wslPath("Ubuntu", "C:/repo")).toThrow();
    expect(() => wslPath("Ubuntu", "/../repo")).toThrow();
    expect(() => wslPath("Ubuntu", "/a\\b")).toThrow();
    expect(resolveWorkspacePath("/a\\b.txt", root)).toBeUndefined();
    expect(resolveWorkspacePath("a\\b.txt", root, true)).toBeUndefined();
    expect(resolveWorkspacePath("Makefile", root, true)).toBe(
      `${root}/Makefile`,
    );
    expect(resolveWorkspacePath("Makefile", undefined, true)).toBe("Makefile");
    expect(resolveWorkspacePath("C:/native/file.ts", root)).toBe(
      "C:/native/file.ts",
    );
  });
});

describe("slash", () => {
  it("preserves backslashes in absolute Unix filenames", () => {
    expect(slash("/tmp/a\\b.txt")).toBe("/tmp/a\\b.txt");
    expect(joinPath("/tmp", "a\\b.txt")).toBe("/tmp/a\\b.txt");
    expect(parentPath("/tmp/a\\b.txt")).toBe("/tmp");
  });
  it("normalizes Windows separators", () => {
    expect(slash("C:\\Users\\me\\code")).toBe("C:/Users/me/code");
  });
});

describe("prettyCwd", () => {
  it("collapses unix and Windows home prefixes", () => {
    expect(prettyCwd("/Users/me")).toBe("~");
    expect(prettyCwd("/Users/me/code")).toBe("~/code");
    expect(prettyCwd("C:\\Users\\me")).toBe("~");
    expect(prettyCwd("C:/Users/me/code/app")).toBe("~/code/app");
  });
});

describe("parentPath and joinPath", () => {
  it("preserves Windows filesystem roots", () => {
    expect(parentPath("//server/share")).toBe("//server/share");
    expect(rebasePath("C:/old", "C:/old", "D:/")).toBe("D:/");
  });
  it("walks Windows drive paths", () => {
    expect(parentPath("C:/Users/me/code")).toBe("C:/Users/me");
    expect(parentPath("C:/Users")).toBe("C:/");
    expect(parentPath("C:/")).toBe("C:/");
    expect(joinPath("C:/Users/me", "code/app")).toBe("C:/Users/me/code/app");
    expect(joinPath("C:/Users/me/code", "..")).toBe("C:/Users/me");
    expect(joinPath("C:/", "Users")).toBe("C:/Users");
  });
});

describe("path relations", () => {
  it("treats backslash and slash as the same path", () => {
    expect(isEqualOrInside("C:\\Users\\me\\app\\src", "C:/Users/me/app")).toBe(
      true,
    );
    expect(isEqualOrInside("C:/Users/me", "C:/")).toBe(true);
    expect(
      rebasePath("C:\\Users\\me\\app\\src\\a.ts", "C:/Users/me/app", "D:/x"),
    ).toBe("D:/x/src/a.ts");
    expect(
      displayPath("C:\\Users\\me\\app\\src\\a.ts", "C:/Users/me/app"),
    ).toBe("src/a.ts");
    expect(projectName("C:\\Users\\me\\app")).toBe("app");
  });

  it("compares Windows paths without case", () => {
    expect(isEqualOrInside("c:/USERS/me/App/src", "C:/Users/ME/app")).toBe(
      true,
    );
    expect(
      rebasePath("c:/USERS/me/App/src/a.ts", "C:/Users/ME/app", "D:/x"),
    ).toBe("D:/x/src/a.ts");
    expect(displayPath("c:/USERS/me/App/src/a.ts", "C:/Users/ME/app")).toBe(
      "src/a.ts",
    );
  });
});
