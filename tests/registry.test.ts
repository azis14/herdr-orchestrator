import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { OrchError } from "../src/errors";
import { getAgent, getProject, loadRegistry, projectForPath, type Registry } from "../src/registry";

function tempRegistry(projects: unknown[], agents?: unknown): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "orch-reg-"));
  fs.writeFileSync(path.join(dir, "projects.json"), JSON.stringify({ projects }));
  fs.writeFileSync(
    path.join(dir, "agents.json"),
    JSON.stringify(
      agents ?? {
        defaultAgent: "claude",
        agents: [
          { name: "claude", kind: "claude", openArgs: [], jobArgs: [] },
          { name: "cursor", kind: "cursor", openArgs: [], jobArgs: ["--force"] },
        ],
      },
    ),
  );
  return dir;
}

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "orch-proj-"));
}

function project(name: string, p: string, extra: object = {}) {
  return { name, path: p, description: name, context: [], ...extra };
}

describe("registry", () => {
  test("loads the real registry", () => {
    const reg = loadRegistry();
    expect(reg.projects.map((p) => p.name)).toEqual(["shop2.0", "shop-api", "shop-ui"]);
    expect(reg.agents.map((a) => a.name)).toEqual(["claude", "cursor"]);
    expect(reg.defaultAgent).toBe("claude");
    // job agents: Cursor runs everything and skips the workspace-trust dialog (new worktrees are untrusted)
    const cursor = reg.agents.find((a) => a.name === "cursor")!;
    expect(cursor.jobArgs).toEqual(["--force"]);
    expect(cursor.worktreeArgs).toEqual(["--trust"]);
    expect(reg.agents.every((a) => a.openArgs.length === 0)).toBe(true);
  });

  test("getProject unknown name lists known names", () => {
    const reg = loadRegistry(tempRegistry([project("shop-api", tempDir()), project("shop-ui", tempDir())]));
    expect(() => getProject(reg, "nope")).toThrow(OrchError);
    try {
      getProject(reg, "nope");
    } catch (e) {
      expect((e as Error).message).toContain("shop-api");
      expect((e as Error).message).toContain("shop-ui");
    }
  });

  test("getProject missing path names the path", () => {
    const missing = path.join(os.tmpdir(), "orch-does-not-exist-xyz");
    const reg = loadRegistry(tempRegistry([project("gone", missing)]));
    expect(() => getProject(reg, "gone")).toThrow(missing);
    expect(() => getProject(reg, "gone")).toThrow(OrchError);
  });

  test("getAgent default order", () => {
    const reg = loadRegistry(
      tempRegistry([project("a", tempDir()), project("b", tempDir(), { defaultAgent: "cursor" })]),
    );
    const a = getProject(reg, "a");
    const b = getProject(reg, "b");
    expect(getAgent(reg).name).toBe("claude");
    expect(getAgent(reg, undefined, a).name).toBe("claude");
    expect(getAgent(reg, undefined, b).name).toBe("cursor");
    expect(getAgent(reg, "claude", b).name).toBe("claude");
    expect(() => getAgent(reg, "codex")).toThrow(OrchError);
    expect(() => getAgent(reg, "codex")).toThrow("claude, cursor");
  });

  test("loadRegistry rejects bad data", () => {
    const d = tempDir();
    expect(() => loadRegistry(tempRegistry([project("a", d), project("a", d)]))).toThrow(OrchError);
    expect(() => loadRegistry(tempRegistry([project("a", d, { defaultAgent: "codex" })]))).toThrow(OrchError);
  });

  test("projectForPath exact and subdirectory", () => {
    const d = tempDir();
    const reg: Registry = loadRegistry(tempRegistry([project("a", d)]));
    expect(projectForPath(reg, d)?.name).toBe("a");
    expect(projectForPath(reg, path.join(d, "src", "x"))?.name).toBe("a");
    expect(projectForPath(reg, "/nowhere")).toBeUndefined();
  });

  test("M6: registry paths are normalized (trailing slash, ..)", () => {
    const d = tempDir();
    const reg = loadRegistry(tempRegistry([project("a", d + "/"), project("b", d + "/sub/..")]));
    expect(reg.projects.map((p) => p.path)).toEqual([d, d]);
    expect(projectForPath(reg, d + ".worktrees/x")?.name).toBe("a");
  });
});
