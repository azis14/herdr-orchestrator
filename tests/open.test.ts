import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { OrchError } from "../src/errors";
import { Herdr } from "../src/herdr";
import { nextAgentName, openAgent, openProject, openTerminal, toAgentName } from "../src/open";
import { claudeDirName } from "../src/sessions";
import { fakeRunner, ok, testDeps, testRegistry, ws, type FakeHandler } from "./fakes";

function runner(workspaces: unknown[], extra: Record<string, FakeHandler> = {}, agents: unknown[] = []) {
  return fakeRunner({
    "workspace list": () => ok({ workspaces }),
    "agent list": () => ok({ agents }),
    "tab create": (a) => ok({ tab: { tab_id: `${a[3]}:t9` }, root_pane: { pane_id: `${a[3]}:p9` } }),
    "workspace create": () =>
      ok({ workspace: { workspace_id: "w7" }, tab: { tab_id: "w7:t1" }, root_pane: { pane_id: "w7:p1" } }),
    "agent start": () => ok({}),
    ...extra,
  });
}

const callsOf = (run: { calls: string[][] }, key: string) => run.calls.filter((c) => c.slice(0, 2).join(" ") === key);

describe("openProject", () => {
  test("cwd opens the tab there", async () => {
    const reg = testRegistry();
    const run = runner([ws("w5", "shop-api", 2)]);
    await openProject(new Herdr(run), reg, "shop-api", undefined, { cwd: "/some/where" });
    expect(callsOf(run, "tab create")[0]).toEqual([
      "tab", "create", "--workspace", "w5", "--cwd", "/some/where", "--no-focus",
    ]);
  });

  test("existing workspace gets a new tab", async () => {
    const reg = testRegistry();
    const p = reg.projects[0].path;
    const run = runner([ws("w5", "shop-api", 2)]);
    const r = await openProject(new Herdr(run), reg, "shop-api");
    expect(callsOf(run, "tab create")[0]).toEqual([
      "tab", "create", "--workspace", "w5", "--cwd", p, "--no-focus",
    ]);
    expect(callsOf(run, "workspace create")).toHaveLength(0);
    expect(callsOf(run, "agent start")[0]).toEqual([
      "agent", "start", "claude", "--kind", "claude", "--pane", "w5:p9",
    ]);
    expect(r).toEqual({
      project: "shop-api",
      agent: "claude",
      agentName: "claude",
      workspaceId: "w5",
      tabId: "w5:t9",
      paneId: "w5:p9",
      createdWorkspace: false,
    });
  });

  test("missing workspace is created and its root pane used", async () => {
    const reg = testRegistry();
    const run = runner([ws("w3", "shop2.0", 1)]);
    const r = await openProject(new Herdr(run), reg, "shop-api");
    expect(callsOf(run, "workspace create")[0]).toEqual([
      "workspace", "create", "--cwd", reg.projects[0].path, "--label", "shop-api", "--no-focus",
    ]);
    expect(callsOf(run, "tab create")).toHaveLength(0);
    expect(callsOf(run, "agent start")[0]).toContain("w7:p1");
    expect(r.createdWorkspace).toBe(true);
  });

  test("two matching workspaces: focused wins, else lowest number", async () => {
    const reg = testRegistry();
    let run = runner([ws("w4", "shop-api", 4), ws("w9", "shop-api", 7, true)]);
    expect((await openProject(new Herdr(run), reg, "shop-api")).workspaceId).toBe("w9");
    run = runner([ws("w9", "shop-api", 7), ws("w4", "shop-api", 4)]);
    expect((await openProject(new Herdr(run), reg, "shop-api")).workspaceId).toBe("w4");
    expect(callsOf(run, "workspace create")).toHaveLength(0);
  });

  test("name collision takes the next free number, from 2", async () => {
    const reg = testRegistry();
    let run = runner([ws("w5", "shop-api", 2)], {}, [{ name: "claude", agent: "claude", pane_id: "w5:p1" }]);
    expect((await openProject(new Herdr(run), reg, "shop-api")).agentName).toBe("claude-2");
    const live = ["claude", "claude-2", "claude-3"].map((name, i) => ({ name, agent: "claude", pane_id: `w5:p${i}` }));
    run = runner([ws("w5", "shop-api", 2)], {}, live);
    expect((await openProject(new Herdr(run), reg, "shop-api")).agentName).toBe("claude-4");
  });

  test("topic labels the new tab; the agent keeps its kind name", async () => {
    const reg = testRegistry();
    const run = runner([ws("w5", "shop-api", 2)]);
    const r = await openProject(new Herdr(run), reg, "shop-api", "cursor", { topic: "login bug" });
    expect(callsOf(run, "tab create")[0]).toEqual([
      "tab", "create", "--workspace", "w5", "--cwd", reg.projects[0].path, "--label", "login bug", "--no-focus",
    ]);
    expect(callsOf(run, "tab rename")).toHaveLength(0);
    expect(r.agentName).toBe("cursor");
  });

  test("topic renames the root tab of a new workspace before the agent starts", async () => {
    const reg = testRegistry();
    const run = runner([], { "tab rename": () => ok({}) });
    await openProject(new Herdr(run), reg, "shop-api", undefined, { topic: "login bug" });
    expect(callsOf(run, "tab rename")[0]).toEqual(["tab", "rename", "w7:t1", "login bug"]);
    const keys = run.calls.map((c) => c.slice(0, 2).join(" "));
    expect(keys.indexOf("tab rename")).toBeLessThan(keys.indexOf("agent start"));
  });

  test("no topic on a new workspace leaves its root tab alone", async () => {
    const reg = testRegistry();
    const run = runner([]);
    await openProject(new Herdr(run), reg, "shop-api");
    expect(callsOf(run, "tab rename")).toHaveLength(0);
  });

  test("cursor uses kind cursor and openArgs (none)", async () => {
    const reg = testRegistry();
    const run = runner([ws("w5", "shop-api", 2)]);
    const r = await openProject(new Herdr(run), reg, "shop-api", "cursor");
    const start = callsOf(run, "agent start")[0];
    expect(start).toContain("cursor");
    expect(start).not.toContain("--");
    expect(r.agentName).toBe("cursor");
  });

  test("explicit args and name override defaults", async () => {
    const reg = testRegistry();
    const run = runner([ws("w5", "shop-api", 2)]);
    const r = await openProject(new Herdr(run), reg, "shop-api", "cursor", { args: ["--force"], name: "job-x" });
    expect(r.agentName).toBe("job-x");
    expect(callsOf(run, "agent start")[0]).toEqual([
      "agent", "start", "job-x", "--kind", "cursor", "--pane", "w5:p9", "--", "--force",
    ]);
  });

  test("agent start failure reports the tab and pane left behind", async () => {
    const reg = testRegistry();
    const run = runner([ws("w5", "shop-api", 2)], {
      "agent start": () => ({ code: 1, stderr: { error: { code: "agent_not_ready", message: "timeout" } } }),
    });
    const e = await openProject(new Herdr(run), reg, "shop-api").catch((x) => x);
    expect(e).toBeInstanceOf(OrchError);
    expect(e.message).toContain("w5:t9");
    expect(e.message).toContain("w5:p9");
    expect(e.message).toContain("agent_not_ready");
    expect(e.message).toContain("pane w5:p9 (agent claude)");
  });

  test("label match is exact", async () => {
    const reg = testRegistry();
    const run = runner([ws("w2", "shop-api-old", 1)]);
    const r = await openProject(new Herdr(run), reg, "shop-api");
    expect(r.createdWorkspace).toBe(true);
  });
});

describe("openTerminal", () => {
  test("existing workspace gets a new tab and no agent starts", async () => {
    const reg = testRegistry();
    const run = runner([ws("w5", "shop-api", 2)]);
    const r = await openTerminal(new Herdr(run), reg, "shop-api");
    expect(callsOf(run, "tab create")[0]).toEqual([
      "tab", "create", "--workspace", "w5", "--cwd", reg.projects[0].path, "--no-focus",
    ]);
    expect(callsOf(run, "agent start")).toHaveLength(0);
    expect(callsOf(run, "agent list")).toHaveLength(0);
    expect(r).toEqual({ project: "shop-api", workspaceId: "w5", tabId: "w5:t9", paneId: "w5:p9", createdWorkspace: false });
  });

  test("missing workspace is created; topic renames its root tab", async () => {
    const reg = testRegistry();
    const run = runner([], { "tab rename": () => ok({}) });
    const r = await openTerminal(new Herdr(run), reg, "shop-api", { topic: "logs" });
    expect(callsOf(run, "workspace create")).toHaveLength(1);
    expect(callsOf(run, "tab rename")[0]).toEqual(["tab", "rename", "w7:t1", "logs"]);
    expect(callsOf(run, "agent start")).toHaveLength(0);
    expect(r.createdWorkspace).toBe(true);
  });

  test("topic labels a new tab in an existing workspace", async () => {
    const reg = testRegistry();
    const run = runner([ws("w5", "shop-api", 2)]);
    await openTerminal(new Herdr(run), reg, "shop-api", { topic: "logs" });
    expect(callsOf(run, "tab create")[0]).toContain("logs");
    expect(callsOf(run, "tab rename")).toHaveLength(0);
  });
});

describe("agent names (herdr: ^[a-z][a-z0-9_-]{0,31}$)", () => {
  const valid = /^[a-z][a-z0-9_-]{0,31}$/;

  test("toAgentName sanitizes, prefixes a leading non-letter, and truncates to 32", () => {
    expect(toAgentName("shop2.0-claude")).toBe("shop2-0-claude");
    expect(toAgentName("2fa-claude")).toBe("x-2fa-claude");
    expect(toAgentName("Shop API")).toBe("shop-api");
    const long = toAgentName("shop2.0-20261023-a-very-long-job-slug-name");
    expect(long.length).toBeLessThanOrEqual(32);
    expect(long).toMatch(valid);
    expect(long.endsWith("-")).toBe(false);
  });

  test("nextAgentName stays valid with or without its numeric suffix", () => {
    expect(nextAgentName("shop2.0-claude", [])).toBe("shop2-0-claude");
    expect(nextAgentName("a".repeat(40), [])).toMatch(valid);
    const n = nextAgentName("a".repeat(40), [{ name: "a".repeat(32) } as any]);
    expect(n).toMatch(valid);
    expect(n.endsWith("-2")).toBe(true);
  });

  test("open on a project with a dot in its name finds its workspace", async () => {
    const reg = testRegistry(["shop2.0"]);
    const run = runner([ws("w3", "shop2.0", 1)]);
    const r = await openProject(new Herdr(run), reg, "shop2.0");
    expect(r.agentName).toBe("claude");
    expect(r.workspaceId).toBe("w3");
  });
});

/** A Claude transcript launched in `folder`. */
function claudeSession(root: string, folder: string, id: string, ts: string) {
  const dir = path.join(root, claudeDirName(folder));
  fs.mkdirSync(dir, { recursive: true });
  const entry = { type: "user", cwd: folder, timestamp: ts, message: { role: "user", content: `task ${id}` } };
  fs.writeFileSync(path.join(dir, `${id}.jsonl`), JSON.stringify(entry) + "\n");
}

/** testDeps whose git lists one worktree (a real temp dir) next to shop-api's base folder. */
function withWorktree(handlers: Record<string, FakeHandler> = {}) {
  const t = testDeps(handlers);
  const base = t.deps.reg.projects[0].path;
  const wt = fs.mkdtempSync(path.join(os.tmpdir(), "orch-wt-"));
  t.deps.git = async () => ({
    code: 0,
    stdout: `worktree ${base}\nHEAD 1111111\nbranch refs/heads/dev\n\nworktree ${wt}\nHEAD 2222222\nbranch refs/heads/feature/x\n`,
    stderr: "",
  });
  return { ...t, base, wt };
}

describe("openAgent", () => {
  test("no new flags: same as openProject, and no git call", async () => {
    const t = testDeps();
    t.deps.git = async () => {
      throw new Error("git must not be called");
    };
    const r = await openAgent(t.deps, "shop-api", undefined, { topic: "x" });
    expect(callsOf(t.run, "tab create")[0]).toEqual([
      "tab", "create", "--workspace", "w5", "--cwd", t.deps.reg.projects[0].path, "--label", "x", "--no-focus",
    ]);
    expect(callsOf(t.run, "agent start")[0]).toEqual(["agent", "start", "claude", "--kind", "claude", "--pane", "w5:p9"]);
    expect(r.folder.base).toBe(true);
    expect(r.session).toBeUndefined();
  });

  test("--folder opens the tab there", async () => {
    const t = withWorktree();
    const r = await openAgent(t.deps, "shop-api", undefined, { folder: t.wt });
    expect(callsOf(t.run, "tab create")[0]).toContain(t.wt);
    expect(r.folder).toEqual({ path: t.wt, branch: "feature/x", base: false });
  });

  test("--continue resumes the newest session in the folder", async () => {
    const t = withWorktree();
    claudeSession(t.deps.claudeProjects, t.wt, "older", "2026-10-01T00:00:00Z");
    claudeSession(t.deps.claudeProjects, t.wt, "newest", "2026-10-05T00:00:00Z");
    claudeSession(t.deps.claudeProjects, t.base, "base-one", "2026-10-09T00:00:00Z");
    const r = await openAgent(t.deps, "shop-api", undefined, { folder: t.wt, continue: true });
    expect(callsOf(t.run, "agent start")[0]).toEqual([
      "agent", "start", "claude", "--kind", "claude", "--pane", "w5:p9", "--", "--resume", "newest",
    ]);
    expect(r.session?.id).toBe("newest");
  });

  test("--continue with no sessions opens nothing", async () => {
    const t = withWorktree();
    const err = await openAgent(t.deps, "shop-api", undefined, { folder: t.wt, continue: true }).catch((e) => e);
    expect(err).toBeInstanceOf(OrchError);
    expect(err.message).toBe(`no claude sessions in ${t.wt}`);
    expect(callsOf(t.run, "tab create")).toHaveLength(0);
  });

  test("--resume refuses a session from another folder", async () => {
    const t = withWorktree();
    claudeSession(t.deps.claudeProjects, t.base, "base-one", "2026-10-09T00:00:00Z");
    const err = await openAgent(t.deps, "shop-api", undefined, { folder: t.wt, resume: "base-one" }).catch((e) => e);
    expect(err).toBeInstanceOf(OrchError);
    expect(err.message).toContain(`no claude session base-one in ${t.wt}`);
    expect(callsOf(t.run, "tab create")).toHaveLength(0);
  });

  test("resuming needs resumeArgs", async () => {
    const t = testDeps();
    t.deps.reg.agents[0] = { name: "claude", kind: "claude", openArgs: [], jobArgs: [] };
    const p = t.deps.reg.projects[0].path;
    claudeSession(t.deps.claudeProjects, p, "s1", "2026-10-01T00:00:00Z");
    const err = await openAgent(t.deps, "shop-api", undefined, { resume: "s1" }).catch((e) => e);
    expect(err).toBeInstanceOf(OrchError);
    expect(err.message).toContain("can't resume");
    expect(callsOf(t.run, "tab create")).toHaveLength(0);
  });

  test("openArgs are kept on resume", async () => {
    const t = testDeps();
    t.deps.reg.agents[0].openArgs = ["--model", "x"];
    const p = t.deps.reg.projects[0].path;
    claudeSession(t.deps.claudeProjects, p, "s1", "2026-10-01T00:00:00Z");
    await openAgent(t.deps, "shop-api", undefined, { resume: "s1" });
    expect(callsOf(t.run, "agent start")[0].slice(-5)).toEqual(["--", "--model", "x", "--resume", "s1"]);
  });

  test("a session open elsewhere still opens, marked", async () => {
    const t = testDeps({
      "agent list": () =>
        ok({ agents: [{ name: "claude-3", agent: "claude", agent_status: "idle", cwd: "/x", pane_id: "w5:p3", tab_id: "w5:t3", workspace_id: "w5", agent_session: { value: "s1" } }] }),
    });
    claudeSession(t.deps.claudeProjects, t.deps.reg.projects[0].path, "s1", "2026-10-01T00:00:00Z");
    const r = await openAgent(t.deps, "shop-api", undefined, { continue: true });
    expect(r.session?.openIn).toEqual({ agentName: "claude-3", workspace: "shop-api", tabId: "w5:t3" });
    expect(callsOf(t.run, "agent start")).toHaveLength(1);
  });
});
