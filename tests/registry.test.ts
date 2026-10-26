import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { OrchError } from "../src/errors";
import {
  addProject,
  formatProjectsJson,
  getAgent,
  getProject,
  loadRegistry,
  ORCH_ROOT,
  projectForPath,
  type Registry,
} from "../src/registry";
import { testRegistry } from "./fakes";

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
    expect(reg.projects.map((p) => p.name)).toEqual(expect.arrayContaining(["shop2.0", "shop-api", "shop-ui"]));
    expect(reg.agents.map((a) => a.name)).toEqual(["claude", "cursor"]);
    expect(reg.defaultAgent).toBe("claude");
    // job agents: Cursor runs everything and skips the workspace-trust dialog (new worktrees are untrusted)
    const cursor = reg.agents.find((a) => a.name === "cursor")!;
    expect(cursor.jobArgs).toEqual(["--force"]);
    expect(cursor.worktreeArgs).toEqual(["--trust"]);
    expect(reg.agents.every((a) => a.openArgs.length === 0)).toBe(true);
  });

  test("missing registry files say to run /setup", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "orch-empty-"));
    expect(() => loadRegistry(dir)).toThrow("no registry yet (missing registry/agents.json): run /setup first");
    fs.writeFileSync(
      path.join(dir, "agents.json"),
      JSON.stringify({ defaultAgent: "claude", agents: [{ name: "claude", kind: "claude", openArgs: [], jobArgs: [] }] }),
    );
    expect(() => loadRegistry(dir)).toThrow("missing registry/projects.json");
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

describe("addProject", () => {
  function setup() {
    const reg = testRegistry();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "orch-regdir-"));
    const file = path.join(dir, "projects.json");
    fs.writeFileSync(file, '{"projects": []}');
    const repo = path.join(tempDir(), "data-ingestion-api");
    fs.mkdirSync(path.join(repo, "docs"), { recursive: true });
    fs.writeFileSync(path.join(repo, "CLAUDE.md"), "");
    return { reg, dir, file, repo };
  }

  const entry = (repo: string, extra: object = {}) => ({
    path: repo,
    description: "Ingestion API (Go)",
    context: ["CLAUDE.md", "docs"],
    ...extra,
  });

  test("formatProjectsJson round-trips the real projects.json byte-for-byte", () => {
    const text = fs.readFileSync(path.join(ORCH_ROOT, "registry/projects.json"), "utf8");
    expect(formatProjectsJson(JSON.parse(text))).toBe(text);
  });

  test("appends an entry, defaulting name to the folder name", () => {
    const { reg, dir, file, repo } = setup();
    const p = addProject(dir, reg, entry(repo));
    expect(p).toEqual({
      name: "data-ingestion-api",
      path: repo,
      description: "Ingestion API (Go)",
      context: ["CLAUDE.md", "docs"],
    });
    expect(JSON.parse(fs.readFileSync(file, "utf8")).projects).toEqual([p]);
    expect(fs.readFileSync(file, "utf8")).toContain('"context": ["CLAUDE.md", "docs"]');
  });

  test("--name overrides the folder name", () => {
    const { reg, dir, repo } = setup();
    expect(addProject(dir, reg, entry(repo, { name: "ingest" })).name).toBe("ingest");
  });

  test("expands a leading ~/", () => {
    const { reg, dir } = setup();
    const home = fs.mkdtempSync(path.join(os.homedir(), ".orch-test-"));
    try {
      const p = addProject(dir, reg, { path: "~/" + path.basename(home), description: "x", context: [] });
      expect(p.path).toBe(home);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  test("rejects a missing path", () => {
    const { reg, dir } = setup();
    const missing = path.join(os.tmpdir(), "orch-does-not-exist-xyz");
    expect(() => addProject(dir, reg, entry(missing))).toThrow(OrchError);
    expect(() => addProject(dir, reg, entry(missing))).toThrow(`does not exist: ${missing}`);
  });

  test("rejects a path that is a file", () => {
    const { reg, dir, repo } = setup();
    const f = path.join(repo, "CLAUDE.md");
    expect(() => addProject(dir, reg, entry(f, { context: [] }))).toThrow(OrchError);
    expect(() => addProject(dir, reg, entry(f, { context: [] }))).toThrow("not a directory");
  });

  test("rejects a duplicate name", () => {
    const { reg, dir, repo } = setup();
    const name = reg.projects[0].name;
    expect(() => addProject(dir, reg, entry(repo, { name }))).toThrow(OrchError);
    expect(() => addProject(dir, reg, entry(repo, { name }))).toThrow("already registered");
  });

  test("rejects a registered path and its worktrees", () => {
    const { reg, dir } = setup();
    const known = reg.projects[0];
    const wt = `${known.path}.worktrees/job-1`;
    fs.mkdirSync(wt, { recursive: true });
    for (const p of [known.path, wt]) {
      const e = { path: p, name: "other", description: "x", context: [] };
      expect(() => addProject(dir, reg, e)).toThrow(OrchError);
      expect(() => addProject(dir, reg, e)).toThrow(`already registered as ${known.name}`);
    }
  });

  test("rejects a folder that contains a registered project or its worktrees dir", () => {
    const { reg, dir } = setup();
    const known = reg.projects[0];
    const wts = `${known.path}.worktrees`;
    fs.mkdirSync(wts, { recursive: true });
    for (const p of [path.dirname(known.path), wts]) {
      const e = { path: p, name: "other", description: "x", context: [] };
      expect(() => addProject(dir, reg, e)).toThrow(OrchError);
      expect(() => addProject(dir, reg, e)).toThrow(`contains registered project ${known.name}`);
    }
  });

  test("rejects names with whitespace or commas", () => {
    const { reg, dir, repo } = setup();
    for (const name of ["a b", "a,b", ""]) {
      expect(() => addProject(dir, reg, entry(repo, { name }))).toThrow(OrchError);
    }
  });

  test("rejects a context entry that is missing", () => {
    const { reg, dir, repo } = setup();
    expect(() => addProject(dir, reg, entry(repo, { context: ["NOPE.md"] }))).toThrow(OrchError);
    expect(() => addProject(dir, reg, entry(repo, { context: ["NOPE.md"] }))).toThrow("NOPE.md");
  });

  test("rejects a context entry outside the repo", () => {
    const { reg, dir, repo } = setup();
    fs.writeFileSync(path.join(repo, "..", "x"), "");
    for (const c of ["../x", path.join(repo, "CLAUDE.md")]) {
      expect(() => addProject(dir, reg, entry(repo, { context: [c] }))).toThrow(OrchError);
    }
  });

  test("rejects an empty description", () => {
    const { reg, dir, repo } = setup();
    expect(() => addProject(dir, reg, entry(repo, { description: "  " }))).toThrow(OrchError);
  });

  test("writes nothing on error", () => {
    const { reg, dir, file, repo } = setup();
    const before = fs.readFileSync(file, "utf8");
    expect(() => addProject(dir, reg, entry(repo, { context: ["NOPE.md"] }))).toThrow(OrchError);
    expect(() => addProject(dir, reg, entry(repo, { name: reg.projects[0].name }))).toThrow(OrchError);
    expect(fs.readFileSync(file, "utf8")).toBe(before);
  });
});
