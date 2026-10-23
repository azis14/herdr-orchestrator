import { describe, expect, test } from "bun:test";
import { main, type GitRunner } from "../orch";
import { OrchError } from "../src/errors";
import { loadJob, newJob, patchAgent, upsertAgent, type JobAgent } from "../src/jobs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { jobAgentName, spawnJobAgent } from "../src/spawn";
import { ok, testDeps, ws, type FakeHandler } from "./fakes";

const worktreeReply = () =>
  ok({ workspace: { workspace_id: "w8" }, tab: { tab_id: "w8:t1" }, root_pane: { pane_id: "w8:p1" } });

function setup(handlers: Record<string, FakeHandler> = {}, gitCode = 0) {
  const gitCalls: { cwd: string; args: string[] }[] = [];
  const order: string[] = [];
  const git: GitRunner = async (cwd, args) => {
    gitCalls.push({ cwd, args });
    order.push("git " + args.join(" "));
    return { code: gitCode, stdout: "", stderr: gitCode ? "fatal: no remote" : "" };
  };
  const t = testDeps(
    {
      "worktree create": (a) => {
        order.push("herdr worktree create");
        return worktreeReply();
      },
      ...handlers,
    },
    { git },
  );
  const job = newJob(t.deps.root, t.deps.reg, {
    slug: "x",
    title: "X",
    request: "R",
    projects: ["shop-api"],
    now: new Date(2026, 9, 23),
  });
  const api = t.deps.reg.projects[0].path;
  return { ...t, job, api, gitCalls, order };
}

const call = (run: { calls: string[][] }, key: string) => run.calls.find((c) => c.slice(0, 2).join(" ") === key);

describe("spawnJobAgent", () => {
  test("herdr mode fetches, then creates the worktree off origin/dev, then starts the agent", async () => {
    const { deps, run, job, api, gitCalls, order } = setup();
    const a = await spawnJobAgent(deps, job.id, "shop-api", undefined, { repoWorktree: false, trust: false });
    expect(gitCalls).toEqual([{ cwd: api, args: ["fetch", "origin", "dev"] }]);
    expect(order).toEqual(["git fetch origin dev", "herdr worktree create"]);
    expect(call(run, "worktree create")).toEqual([
      "worktree", "create", "--cwd", api, "--branch", "feature/20261023-x", "--base", "origin/dev",
      "--path", `${api}.worktrees/20261023-x`, "--label", "shop-api:20261023-x", "--no-focus",
    ]);
    expect(call(run, "agent start")).toEqual([
      "agent", "start", jobAgentName("shop-api", "20261023-x"), "--kind", "claude", "--pane", "w8:p1",
    ]);
    expect(a).toEqual({
      project: "shop-api",
      agent: "claude",
      agentName: jobAgentName("shop-api", "20261023-x"),
      workspaceId: "w8",
      tabId: "w8:t1",
      paneId: "w8:p1",
      mode: "herdr-worktree",
      worktreePath: `${api}.worktrees/20261023-x`,
      branch: "feature/20261023-x",
      createdWorkspace: true,
      status: "started",
    });
    expect(loadJob(deps.root, job.id).agents).toEqual([a]);
  });

  test("fetch failure stops before herdr creates anything (only the read-only agent list ran)", async () => {
    const { deps, run, job } = setup({}, 1);
    const e = await spawnJobAgent(deps, job.id, "shop-api", undefined, { repoWorktree: false, trust: false }).catch((x) => x);
    expect(e).toBeInstanceOf(OrchError);
    expect(e.message).toContain("no remote");
    expect(run.calls.map((c) => c.slice(0, 2).join(" "))).toEqual(["agent list"]);
  });

  test("cursor job agent in a job worktree gets --force and --trust", async () => {
    const { deps, run, job } = setup();
    await spawnJobAgent(deps, job.id, "shop-api", "cursor", { repoWorktree: false, trust: false });
    expect(call(run, "agent start")!.slice(-3)).toEqual(["--", "--force", "--trust"]);
  });

  test("I5: cursor in repo-worktree mode (user's main checkout) does not get --trust", async () => {
    const { deps, run, job } = setup({ "workspace list": () => ok({ workspaces: [ws("w5", "shop-api", 2)] }) });
    await spawnJobAgent(deps, job.id, "shop-api", "cursor", { repoWorktree: true, trust: false });
    const start = call(run, "agent start")!;
    expect(start).toContain("--force");
    expect(start).not.toContain("--trust");
  });

  test("repo mode opens a tab in the main checkout without git", async () => {
    const { deps, run, job, api, gitCalls } = setup({
      "workspace list": () => ok({ workspaces: [ws("w5", "shop-api", 2)] }),
    });
    const a = await spawnJobAgent(deps, job.id, "shop-api", undefined, { repoWorktree: true, trust: false });
    expect(gitCalls).toEqual([]);
    expect(call(run, "worktree create")).toBeUndefined();
    expect(call(run, "tab create")).toContain(api);
    expect(a).toMatchObject({
      mode: "repo-worktree",
      agentName: jobAgentName("shop-api", "20261023-x"),
      paneId: "w5:p9",
      createdWorkspace: false,
    });
    expect(a.worktreePath).toBeUndefined();
    expect(a.branch).toBeUndefined();
  });

  test("--trust passes --trust-repository", async () => {
    const { deps, run, job } = setup();
    await spawnJobAgent(deps, job.id, "shop-api", undefined, { repoWorktree: false, trust: true });
    expect(call(run, "worktree create")).toContain("--trust-repository");
  });

  test("rejects a project not in the job, and a duplicate live spawn", async () => {
    const { deps, job } = setup();
    const o = { repoWorktree: false, trust: false };
    await expect(spawnJobAgent(deps, job.id, "shop-ui", undefined, o)).rejects.toThrow(OrchError);
    await spawnJobAgent(deps, job.id, "shop-api", undefined, o);
    await expect(spawnJobAgent(deps, job.id, "shop-api", undefined, o)).rejects.toThrow(OrchError);
    patchAgent(deps.root, job.id, jobAgentName("shop-api", "20261023-x"), { status: "stopped" });
    await spawnJobAgent(deps, job.id, "shop-api", undefined, o);
  });

  test("cli job spawn prints the spawned line", async () => {
    const { deps, out, job } = setup();
    expect(await main(["job", "spawn", job.id, "shop-api", "cursor"], deps)).toBe(0);
    expect(out.pop()).toBe(`spawned ${jobAgentName("shop-api", "20261023-x")} (cursor, herdr-worktree) pane w8:p1`);
  });

  test("I4: agent names stay valid and distinct for long same-day slugs", () => {
    const valid = /^[a-z][a-z0-9_-]{0,31}$/;
    const names = [
      jobAgentName("shop-api", "20261023-fix-login-redirect"),
      jobAgentName("shop-api", "20261023-fix-login-redirect-2"),
      jobAgentName("shop-api", "20261023-pagination-for-users"),
      jobAgentName("shop-api", "20261023-pagination-for-orders"),
      jobAgentName("shop2.0", "20261023-pagination-for-orders"),
    ];
    for (const n of names) expect(n).toMatch(valid);
    expect(new Set(names).size).toBe(names.length);
    expect(jobAgentName("shop-api", "20261023-x")).toBe(jobAgentName("shop-api", "20261023-x"));
  });

  test("I4: a live agent already holding the name fails before git or herdr creates anything", async () => {
    const name = jobAgentName("shop-api", "20261023-x");
    const { deps, run, job, gitCalls } = setup({
      "agent list": () => ok({ agents: [{ name, agent: "claude", pane_id: "w1:p1" }] }),
    });
    await expect(
      spawnJobAgent(deps, job.id, "shop-api", undefined, { repoWorktree: false, trust: false }),
    ).rejects.toThrow(OrchError);
    expect(gitCalls).toEqual([]);
    expect(call(run, "worktree create")).toBeUndefined();
  });

  test("I1+I2: respawn after stop reopens the existing worktree and keeps recorded paths", async () => {
    const { deps, run, job, api, gitCalls } = setup({
      "workspace create": () =>
        ok({ workspace: { workspace_id: "w9" }, tab: { tab_id: "w9:t1" }, root_pane: { pane_id: "w9:p1" } }),
    });
    const o = { repoWorktree: false, trust: false };
    const first = await spawnJobAgent(deps, job.id, "shop-api", undefined, o);
    fs.mkdirSync(first.worktreePath!, { recursive: true });
    patchAgent(deps.root, job.id, first.agentName, { status: "stopped", designPath: "/d.md", planPath: "/p.md" });
    gitCalls.length = 0;
    const again = await spawnJobAgent(deps, job.id, "shop-api", undefined, o);
    expect(gitCalls).toEqual([]);
    expect(run.calls.filter((c) => c[0] === "worktree")).toHaveLength(1);
    expect(call(run, "workspace create")).toEqual([
      "workspace", "create", "--cwd", `${api}.worktrees/20261023-x`, "--label", "shop-api:20261023-x", "--no-focus",
    ]);
    expect(again).toMatchObject({
      paneId: "w9:p1",
      worktreePath: `${api}.worktrees/20261023-x`,
      branch: "feature/20261023-x",
      designPath: "/d.md",
      planPath: "/p.md",
      createdWorkspace: true,
      status: "started",
    });
    expect(loadJob(deps.root, job.id).agents).toHaveLength(1);
    fs.rmSync(first.worktreePath!, { recursive: true });
  });

  test("I3: a failed agent start is recorded as start-failed with its placement", async () => {
    const { deps, job, api } = setup({
      "agent start": () => ({ code: 1, stderr: { error: { code: "agent_not_ready", message: "blocked" } } }),
    });
    const e = await spawnJobAgent(deps, job.id, "shop-api", undefined, { repoWorktree: false, trust: false }).catch(
      (x) => x,
    );
    expect(e).toBeInstanceOf(OrchError);
    expect(e.message).toContain("w8:p1");
    expect(loadJob(deps.root, job.id).agents[0]).toMatchObject({
      status: "start-failed",
      paneId: "w8:p1",
      workspaceId: "w8",
      worktreePath: `${api}.worktrees/20261023-x`,
      createdWorkspace: true,
    });
  });

  test("I3: spawning a start-failed agent that is now live adopts it without creating anything", async () => {
    let live: unknown[] = [];
    let startOk = false;
    const { deps, run, job, gitCalls } = setup({
      "agent list": () => ok({ agents: live }),
      "agent start": () =>
        startOk ? ok({}) : { code: 1, stderr: { error: { code: "agent_not_ready", message: "blocked" } } },
    });
    const o = { repoWorktree: false, trust: false };
    await spawnJobAgent(deps, job.id, "shop-api", undefined, o).catch(() => {});
    const name = jobAgentName("shop-api", job.id);
    live = [{ name, agent: "claude", pane_id: "w8:p1" }];
    startOk = true;
    const callsBefore = run.calls.length;
    gitCalls.length = 0;
    const a = await spawnJobAgent(deps, job.id, "shop-api", undefined, o);
    expect(a).toMatchObject({ status: "started", paneId: "w8:p1" });
    expect(gitCalls).toEqual([]);
    expect(run.calls.slice(callsBefore).map((c) => c.slice(0, 2).join(" "))).toEqual(["agent list"]);
  });
});

describe("resuming a cleaned-up agent", () => {
  const o = { repoWorktree: false, trust: false };
  const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "orch-resume-"));

  /** A job agent record as `orch cleanup --close` leaves it. */
  function stopped(
    t: ReturnType<typeof setup>,
    over: Partial<JobAgent>,
    agent = "claude",
  ): JobAgent {
    const record: JobAgent = {
      project: "shop-api",
      agent,
      agentName: jobAgentName("shop-api", t.job.id),
      workspaceId: "w1",
      tabId: "w1:t1",
      paneId: "w1:p1",
      mode: "herdr-worktree",
      createdWorkspace: true,
      status: "stopped",
      ...over,
    };
    upsertAgent(t.deps.root, t.job.id, record);
    return record;
  }

  const placed = {
    "workspace create": () =>
      ok({ workspace: { workspace_id: "w9" }, tab: { tab_id: "w9:t1" }, root_pane: { pane_id: "w9:p1" } }),
  };

  test("resumes a stopped agent in its job worktree", async () => {
    const t = setup(placed);
    const wt = tmp();
    stopped(t, { worktreePath: wt, branch: "feature/x", lastCwd: wt, sessionId: "S1" });
    const a = await spawnJobAgent(t.deps, t.job.id, "shop-api", undefined, o);
    expect(call(t.run, "workspace create")).toEqual([
      "workspace", "create", "--cwd", wt, "--label", "shop-api:20261023-x", "--no-focus",
    ]);
    expect(call(t.run, "agent start")).toEqual([
      "agent", "start", jobAgentName("shop-api", t.job.id), "--kind", "claude", "--pane", "w9:p1", "--", "--resume", "S1",
    ]);
    expect(a.resumedSession).toBe("S1");
    const saved = loadJob(t.deps.root, t.job.id).agents[0];
    expect(saved).toMatchObject({ status: "started", paneId: "w9:p1", worktreePath: wt, createdWorkspace: true });
    expect(saved).not.toHaveProperty("lastCwd");
    expect(saved).not.toHaveProperty("sessionId");
    expect(saved).not.toHaveProperty("resumedSession");
    fs.rmSync(wt, { recursive: true });
  });

  test("resumes a repo-worktree agent in its own folder without worktreeArgs", async () => {
    const t = setup();
    const wt = tmp();
    const own = tmp();
    stopped(t, { agent: "cursor", mode: "repo-worktree", worktreePath: wt, lastCwd: own, sessionId: "S1" }, "cursor");
    const a = await spawnJobAgent(t.deps, t.job.id, "shop-api", "cursor", o);
    expect(call(t.run, "tab create")).toEqual([
      "tab", "create", "--workspace", "w5", "--cwd", own, "--label", jobAgentName("shop-api", t.job.id), "--no-focus",
    ]);
    const start = call(t.run, "agent start")!;
    expect(start.slice(start.indexOf("--"))).toEqual(["--", "--force", "--resume", "S1"]);
    expect(start).not.toContain("--trust");
    expect(a.resumedSession).toBe("S1");
    expect(call(t.run, "workspace create")).toBeUndefined();
    const saved = loadJob(t.deps.root, t.job.id).agents[0];
    expect(saved).toMatchObject({ status: "started", paneId: "w5:p9", mode: "repo-worktree" });
    expect(saved).not.toHaveProperty("lastCwd");
    expect(saved).not.toHaveProperty("sessionId");
    fs.rmSync(wt, { recursive: true });
    fs.rmSync(own, { recursive: true });
  });

  test("starts fresh when no session was recorded", async () => {
    const t = setup(placed);
    const wt = tmp();
    stopped(t, { worktreePath: wt, lastCwd: wt });
    const a = await spawnJobAgent(t.deps, t.job.id, "shop-api", undefined, o);
    expect(call(t.run, "agent start")).not.toContain("--resume");
    expect(a.resumedSession).toBeUndefined();
    expect(a.resumedFresh).toBe(true);
    expect(loadJob(t.deps.root, t.job.id).agents[0]).not.toHaveProperty("lastCwd");
    fs.rmSync(wt, { recursive: true });
  });

  test("keeps lastCwd and sessionId after a failed start", async () => {
    const t = setup({
      ...placed,
      "agent start": () => ({ code: 1, stderr: { error: { code: "agent_not_ready", message: "blocked" } } }),
    });
    const wt = tmp();
    stopped(t, { worktreePath: wt, lastCwd: wt, sessionId: "S1" });
    await expect(spawnJobAgent(t.deps, t.job.id, "shop-api", undefined, o)).rejects.toThrow(OrchError);
    expect(loadJob(t.deps.root, t.job.id).agents[0]).toMatchObject({
      status: "start-failed",
      lastCwd: wt,
      sessionId: "S1",
    });
    fs.rmSync(wt, { recursive: true });
  });

  test("falls back to the recorded worktree when lastCwd no longer exists", async () => {
    const t = setup(placed);
    const wt = tmp();
    stopped(t, { worktreePath: wt, lastCwd: path.join(wt, "gone"), sessionId: "S1" });
    const a = await spawnJobAgent(t.deps, t.job.id, "shop-api", undefined, o);
    expect(call(t.run, "workspace create")![3]).toBe(wt);
    expect(call(t.run, "agent start")).not.toContain("--resume");
    expect(a.resumedSession).toBeUndefined();
    expect(a.resumedFresh).toBe(true);
    expect(loadJob(t.deps.root, t.job.id).agents[0]).not.toHaveProperty("lastCwd");
    fs.rmSync(wt, { recursive: true });
  });

  test("a session with no resumeArgs on the agent starts fresh", async () => {
    const t = setup(placed);
    t.deps.reg.agents.find((x) => x.name === "claude")!.resumeArgs = undefined;
    const wt = tmp();
    stopped(t, { worktreePath: wt, lastCwd: wt, sessionId: "S1" });
    const a = await spawnJobAgent(t.deps, t.job.id, "shop-api", undefined, o);
    expect(call(t.run, "agent start")).not.toContain("--resume");
    expect(a.resumedSession).toBeUndefined();
    expect(a.resumedFresh).toBe(true);
    fs.rmSync(wt, { recursive: true });
  });

  test.each([
    ["a trailing slash", (wt: string) => `${wt}/`],
    ["a subdirectory", (wt: string) => path.join(wt, "src")],
  ])("lastCwd with %s still counts as the job worktree", async (_name, toCwd) => {
    const t = setup(placed);
    const wt = tmp();
    fs.mkdirSync(path.join(wt, "src"));
    const cwd = toCwd(wt);
    stopped(t, { agent: "cursor", worktreePath: wt, lastCwd: cwd, sessionId: "S1" }, "cursor");
    await spawnJobAgent(t.deps, t.job.id, "shop-api", "cursor", o);
    expect(call(t.run, "workspace create")![3]).toBe(cwd);
    expect(call(t.run, "tab create")).toBeUndefined();
    const start = call(t.run, "agent start")!;
    expect(start.slice(start.indexOf("--"))).toEqual(["--", "--force", "--trust", "--resume", "S1"]);
    fs.rmSync(wt, { recursive: true });
  });

  test("a sibling folder that merely shares the worktree's prefix is not the job worktree", async () => {
    const t = setup();
    const wt = tmp();
    const sibling = `${wt}-other`;
    fs.mkdirSync(sibling);
    stopped(t, { agent: "cursor", mode: "repo-worktree", worktreePath: wt, lastCwd: sibling, sessionId: "S1" }, "cursor");
    await spawnJobAgent(t.deps, t.job.id, "shop-api", "cursor", o);
    expect(call(t.run, "agent start")).not.toContain("--trust");
    fs.rmSync(wt, { recursive: true });
    fs.rmSync(sibling, { recursive: true });
  });

  test("a repo-worktree record whose lastCwd is its recorded worktreePath gets no --trust and opens as a tab", async () => {
    const t = setup();
    const wt = tmp();
    stopped(t, { agent: "cursor", mode: "repo-worktree", worktreePath: wt, lastCwd: wt, sessionId: "S1" }, "cursor");
    const a = await spawnJobAgent(t.deps, t.job.id, "shop-api", undefined, o);
    expect(call(t.run, "workspace create")).toBeUndefined();
    expect(call(t.run, "tab create")![5]).toBe(wt);
    const start = call(t.run, "agent start")!;
    expect(start.slice(start.indexOf("--"))).toEqual(["--", "--force", "--resume", "S1"]);
    expect(start).not.toContain("--trust");
    expect(a.resumedSession).toBe("S1");
    expect(loadJob(t.deps.root, t.job.id).agents[0]).toMatchObject({ mode: "repo-worktree", createdWorkspace: false });
    fs.rmSync(wt, { recursive: true });
  });

  test("a repo-worktree record with no lastCwd reopens its worktreePath without --trust", async () => {
    const t = setup();
    const wt = tmp();
    stopped(t, { agent: "cursor", mode: "repo-worktree", worktreePath: wt }, "cursor");
    await spawnJobAgent(t.deps, t.job.id, "shop-api", undefined, o);
    expect(call(t.run, "workspace create")).toBeUndefined();
    expect(call(t.run, "tab create")![5]).toBe(wt);
    expect(call(t.run, "agent start")).not.toContain("--trust");
    fs.rmSync(wt, { recursive: true });
  });

  test("respawn without an explicit agent keeps the record's agent kind and resumes its session", async () => {
    const t = setup(placed);
    const wt = tmp();
    stopped(t, { agent: "cursor", worktreePath: wt, lastCwd: wt, sessionId: "C1" }, "cursor");
    const a = await spawnJobAgent(t.deps, t.job.id, "shop-api", undefined, o);
    const start = call(t.run, "agent start")!;
    expect(start.slice(start.indexOf("--kind"))).toEqual([
      "--kind", "cursor", "--pane", "w9:p1", "--", "--force", "--trust", "--resume", "C1",
    ]);
    expect(a.resumedSession).toBe("C1");
    expect(loadJob(t.deps.root, t.job.id).agents[0]).toMatchObject({ agent: "cursor", status: "started" });
    fs.rmSync(wt, { recursive: true });
  });

  test("an explicit agent that differs from the record's does not resume the old session", async () => {
    const t = setup(placed);
    const wt = tmp();
    stopped(t, { agent: "cursor", worktreePath: wt, lastCwd: wt, sessionId: "C1" }, "cursor");
    const a = await spawnJobAgent(t.deps, t.job.id, "shop-api", "claude", o);
    const start = call(t.run, "agent start")!;
    expect(start).toContain("claude");
    expect(start).not.toContain("--resume");
    expect(a.resumedSession).toBeUndefined();
    expect(a.resumedFresh).toBe(true);
    fs.rmSync(wt, { recursive: true });
  });

  test("cli job spawn reports the resumed session, or that it started fresh", async () => {
    const t = setup(placed);
    const wt = tmp();
    const rec = stopped(t, { worktreePath: wt, lastCwd: wt, sessionId: "S1" });
    expect(await main(["job", "spawn", t.job.id, "shop-api"], t.deps)).toBe(0);
    expect(t.out.pop()).toBe(
      `spawned ${rec.agentName} (claude, herdr-worktree) pane w9:p1 resumed session S1`,
    );
    stopped(t, { worktreePath: wt, lastCwd: wt });
    expect(await main(["job", "spawn", t.job.id, "shop-api"], t.deps)).toBe(0);
    expect(t.out.pop()).toBe(
      `spawned ${rec.agentName} (claude, herdr-worktree) pane w9:p1 (fresh: no session to resume)`,
    );
    fs.rmSync(wt, { recursive: true });
  });
});
