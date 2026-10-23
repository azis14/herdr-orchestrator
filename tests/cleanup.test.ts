import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { closeAgents, findDormant, formatAge } from "../src/cleanup";
import { OrchError } from "../src/errors";
import { HerdrError } from "../src/herdr";
import { loadJob, newJob, setStage, upsertAgent } from "../src/jobs";
import { ok, testDeps, ws } from "./fakes";

const NOW = new Date("2026-10-23T12:00:00Z");
const HOUR = 3_600_000;

const agent = (o: Record<string, unknown>) => ({
  agent: "claude",
  agent_status: "idle",
  cwd: "/nowhere",
  pane_id: "w3:p1",
  tab_id: "w3:t1",
  workspace_id: "w3",
  ...o,
});

const session = (id: string) => ({ agent: "claude", kind: "id", source: "herdr:claude", value: id });

function writeSession(projects: string, id: string, at: string, reply = "Done.") {
  const file = path.join(projects, "-proj", `${id}.jsonl`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const lines = [
    { type: "user", timestamp: at, message: { content: "hi" } },
    { type: "assistant", timestamp: at, message: { content: [{ type: "text", text: reply }] } },
  ];
  fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
}

interface World {
  agents?: object[];
  workspaces?: object[];
  tabs?: Record<string, object[]>;
  procs?: Record<string, { pid: number; name: string }[]>;
  read?: string;
  /** Panes whose `pane process-info` fails. */
  failProcs?: string[];
  failTabs?: boolean;
}

function setup(w: World, overrides = {}, handlers: Record<string, (a: string[]) => object> = {}) {
  return testDeps(
    {
      "agent list": () => ok({ agents: w.agents ?? [] }),
      "workspace list": () =>
        ok({ workspaces: w.workspaces ?? [{ ...ws("w3", "shop2.0", 1), tab_count: 3 }] }),
      "tab list": (a) =>
        w.failTabs
          ? { code: 1, stderr: "tab list boom" }
          : ok({
          tabs: w.tabs?.[a[3]] ?? [{ tab_id: "w3:t1", workspace_id: a[3], label: "t", pane_count: 1 }],
        }),
      "pane process-info": (a) =>
        w.failProcs?.includes(a[3])
          ? { code: 1, stderr: "process-info boom" }
          : ok({ process_info: { pane_id: a[3], shell_pid: 1, foreground_processes: w.procs?.[a[3]] ?? [] } }),
      "agent read": () => ({ stdout: w.read ?? "" }),
      "pane close": () => ok({ type: "ok" }),
      "tab close": () => ok({ type: "ok" }),
      "workspace close": () => ok({ type: "ok" }),
      ...handlers,
    },
    { now: () => NOW, ...overrides },
  );
}

const opts = { workspaces: [] as string[], idleMs: HOUR };

describe("formatAge", () => {
  test("two largest units, zero minor unit dropped", () => {
    expect(formatAge(45 * 60_000)).toBe("45m");
    expect(formatAge(3 * HOUR + 5 * 60_000)).toBe("3h 5m");
    expect(formatAge(3 * HOUR)).toBe("3h");
    expect(formatAge(26 * HOUR)).toBe("1d 2h");
    expect(formatAge(48 * HOUR)).toBe("2d");
  });
});

describe("findDormant", () => {
  test("lists an idle agent whose last turn is older than --idle", async () => {
    const { deps } = setup({ agents: [agent({ pane_id: "w3:pF", agent_session: session("s1"), state_change_seq: 6 })] });
    writeSession(deps.claudeProjects, "s1", "2026-10-23T09:00:00Z", "Shipped it.");
    const r = await findDormant(deps, opts);
    expect(r.skipped).toEqual([]);
    expect(r.candidates).toHaveLength(1);
    const c = r.candidates[0];
    expect(c.idleMs).toBe(3 * HOUR);
    expect(c.lastMessage).toBe("Shipped it.");
    expect(c.pick).toBe(`w3:pF@6-${new Date("2026-10-23T09:00:00Z").getTime()}`);
    expect(c).toMatchObject({ paneId: "w3:pF", workspace: "shop2.0", sessionId: "s1", project: null, closes: "tab" });
  });

  test("skips recent, busy, blocked and review-stage agents", async () => {
    const { deps } = setup({
      agents: [
        agent({ name: "recent", pane_id: "w3:p1", agent_session: session("s-recent") }),
        agent({ name: "busy", pane_id: "w3:p2", agent_session: session("s-busy") }),
        agent({ name: "blocked", pane_id: "w3:p3", agent_status: "blocked", agent_session: session("s-blocked") }),
        agent({ name: "review", pane_id: "w3:p4", agent_session: session("s-review") }),
      ],
      procs: { "w3:p2": [{ pid: 7, name: "claude" }, { pid: 8, name: "node" }] },
    }, { children: async (pid: number) => (pid === 7 ? [42] : []) });
    for (const id of ["s-recent", "s-busy", "s-blocked", "s-review"]) {
      writeSession(deps.claudeProjects, id, id === "s-recent" ? "2026-10-23T11:30:00Z" : "2026-10-23T08:00:00Z");
    }
    const job = newJob(deps.root, deps.reg, { slug: "x", title: "T", request: "R", projects: ["shop-api"], now: NOW });
    upsertAgent(deps.root, job.id, {
      project: "shop-api", agent: "claude", agentName: "review", workspaceId: "w3", tabId: "w3:t1",
      paneId: "w3:p4", mode: "herdr-worktree", status: "started",
    });
    setStage(deps.root, job.id, "plan-review");

    const r = await findDormant(deps, opts);
    expect(r.candidates).toEqual([]);
    const reasons = Object.fromEntries(r.skipped.map((s) => [s.agentName, s.reason]));
    expect(reasons).toEqual({
      recent: "active 30m ago",
      busy: "running child processes",
      blocked: "state blocked",
      review: `job ${job.id} waiting at plan-review`,
    });
    expect(r.skipped[0]).toMatchObject({ workspace: "shop2.0" });
  });

  test("a cursor agent whose foreground process is named node is still checked for children", async () => {
    const { deps } = setup(
      {
        agents: [agent({ agent: "cursor", name: "cursor-1" })],
        procs: { "w3:p1": [{ pid: 9, name: "node" }] },
      },
      { children: async (pid: number) => (pid === 9 ? [42] : []) },
    );
    const r = await findDormant(deps, opts);
    expect(r.candidates).toEqual([]);
    expect(r.skipped).toEqual([
      { agentName: "cursor-1", paneId: "w3:p1", workspace: "shop2.0", reason: "running child processes" },
    ]);
  });

  test("only inspects processes of agents that passed the state and idle checks", async () => {
    const { deps, run } = setup({
      agents: [
        agent({ pane_id: "w3:p1", agent_status: "working", agent_session: session("a") }),
        agent({ pane_id: "w3:p2", agent_session: session("b") }),
      ],
    });
    writeSession(deps.claudeProjects, "b", "2026-10-23T11:59:00Z");
    await findDormant(deps, opts);
    expect(run.calls.filter((c) => c[0] === "pane")).toEqual([]);
  });

  test("unknown activity is a candidate", async () => {
    const { deps } = setup({
      agents: [agent({ agent: "cursor", name: "cursor-1" })],
      read: "\n  some output\n  last line here  \n\n",
    });
    const r = await findDormant(deps, opts);
    expect(r.candidates).toHaveLength(1);
    expect(r.candidates[0]).toMatchObject({ idleMs: null, lastMessage: "last line here", pick: "w3:p1@0-0" });
  });

  test("closes reflects pane and tab counts", async () => {
    const tab = (id: string, n: number) => ({ tab_id: id, workspace_id: "w3", label: id, pane_count: n });
    const cases: [number, number, string][] = [
      [3, 2, "pane"],
      [3, 1, "tab"],
      [1, 1, "tab+workspace"],
    ];
    for (const [tabCount, panes, closes] of cases) {
      const { deps } = setup({
        agents: [agent({})],
        workspaces: [{ ...ws("w3", "shop2.0", 1), tab_count: tabCount }],
        tabs: { w3: [tab("w3:t1", panes), tab("w3:t2", 1)] },
      });
      const r = await findDormant(deps, opts);
      expect(r.candidates[0].closes).toBe(closes);
    }
  });

  test("label filter matches every workspace with that label", async () => {
    const { deps } = setup({
      workspaces: [ws("w3", "shop2.0", 1), ws("w4", "devnotes", 2), ws("w6", "shop2.0", 3)],
      agents: [
        agent({ pane_id: "w3:p1", workspace_id: "w3" }),
        agent({ pane_id: "w4:p1", workspace_id: "w4" }),
        agent({ pane_id: "w6:p1", workspace_id: "w6" }),
      ],
    });
    const r = await findDormant(deps, { workspaces: ["shop2.0"], idleMs: HOUR });
    expect(r.candidates.map((c) => c.paneId).sort()).toEqual(["w3:p1", "w6:p1"]);
    expect(r.candidates.every((c) => c.workspace === "shop2.0")).toBe(true);
  });

  test("unknown label is an error listing known labels", async () => {
    const { deps } = setup({ workspaces: [ws("w3", "shop2.0", 1), ws("w4", "devnotes", 2)] });
    const e = await findDormant(deps, { workspaces: ["nope"], idleMs: HOUR }).catch((e) => e);
    expect(e).toBeInstanceOf(OrchError);
    expect(e.message).toContain("shop2.0, devnotes");
  });

  test("design-review and integrate are skipped like plan-review", async () => {
    const stages = ["design-review", "integrate"] as const;
    const { deps } = setup({
      agents: stages.map((st, i) => agent({ name: st, pane_id: `w3:p${i + 1}`, agent_session: session(`s-${st}`) })),
    });
    const ids: string[] = [];
    stages.forEach((st, i) => {
      writeSession(deps.claudeProjects, `s-${st}`, "2026-10-23T08:00:00Z");
      const job = newJob(deps.root, deps.reg, { slug: `j${i}`, title: "T", request: "R", projects: ["shop-api"], now: NOW });
      ids.push(job.id);
      upsertAgent(deps.root, job.id, {
        project: "shop-api", agent: "claude", agentName: st, workspaceId: "w3", tabId: "w3:t1",
        paneId: `w3:p${i + 1}`, mode: "herdr-worktree", status: "started",
      });
      setStage(deps.root, job.id, st);
    });
    const r = await findDormant(deps, opts);
    expect(r.candidates).toEqual([]);
    expect(Object.fromEntries(r.skipped.map((s) => [s.agentName, s.reason]))).toEqual({
      "design-review": `job ${ids[0]} waiting at design-review`,
      integrate: `job ${ids[1]} waiting at integrate`,
    });
  });

  test("an agent with a session but no transcript has unknown idleMs", async () => {
    const { deps } = setup({ agents: [agent({ agent_session: session("ghost") })], read: "hello\n" });
    const r = await findDormant(deps, opts);
    expect(r.candidates).toHaveLength(1);
    expect(r.candidates[0]).toMatchObject({ idleMs: null, sessionId: "ghost", pick: "w3:p1@0-0" });
  });

  test("a tab missing from tab list means closes pane", async () => {
    const { deps } = setup({
      agents: [agent({})],
      workspaces: [{ ...ws("w3", "shop2.0", 1), tab_count: 1 }],
      tabs: { w3: [{ tab_id: "w3:other", workspace_id: "w3", label: "x", pane_count: 1 }] },
    });
    expect((await findDormant(deps, opts)).candidates[0].closes).toBe("pane");
  });

  test("a threshold of 0 ignores a timestamp slightly in the future", async () => {
    const { deps } = setup({ agents: [agent({ agent_session: session("skew") })] });
    writeSession(deps.claudeProjects, "skew", "2026-10-23T12:00:30Z");
    const r = await findDormant(deps, { workspaces: [], idleMs: 0 });
    expect(r.skipped).toEqual([]);
    expect(r.candidates).toHaveLength(1);
    // with a real threshold the same agent is recent
    const r2 = await findDormant(deps, opts);
    expect(r2.skipped).toHaveLength(1);
  });

  test("process info failing for one agent skips it and the scan continues", async () => {
    const { deps } = setup({
      agents: [agent({ name: "bad", pane_id: "w3:p1" }), agent({ name: "good", pane_id: "w3:p2" })],
      failProcs: ["w3:p1"],
    });
    const r = await findDormant(deps, opts);
    expect(r.skipped).toEqual([
      { agentName: "bad", paneId: "w3:p1", workspace: "shop2.0", reason: "process info unavailable" },
    ]);
    expect(r.candidates.map((c) => c.agentName)).toEqual(["good"]);
  });

  test("a children lookup that fails with HerdrError skips the agent too", async () => {
    const { deps } = setup(
      { agents: [agent({}) ], procs: { "w3:p1": [{ pid: 5, name: "claude" }] } },
      { children: async () => { throw new HerdrError("boom", []); } },
    );
    const r = await findDormant(deps, opts);
    expect(r.candidates).toEqual([]);
    expect(r.skipped[0].reason).toBe("process info unavailable");
  });

  test("tab list failing skips that workspace's candidates and the scan continues", async () => {
    const { deps } = setup({
      workspaces: [{ ...ws("w3", "shop2.0", 1), tab_count: 2 }],
      agents: [agent({ name: "a" })],
      failTabs: true,
    });
    const r = await findDormant(deps, opts);
    expect(r.candidates).toEqual([]);
    expect(r.skipped).toEqual([
      { agentName: "a", paneId: "w3:p1", workspace: "shop2.0", reason: "tab info unavailable" },
    ]);
  });
});

describe("closeAgents", () => {
  const tab = (id: string, panes = 1) => ({ tab_id: id, workspace_id: "w3", label: id, pane_count: panes });
  const closes = (run: { calls: string[][] }) => run.calls.filter((c) => c[1] === "close").map((c) => c.join(" "));

  test("closes the pane when the tab has other panes", async () => {
    const { deps, run } = setup({ agents: [agent({})], tabs: { w3: [tab("w3:t1", 2)] } });
    const r = await closeAgents(deps, ["w3:p1@0-0"]);
    expect(r.refused).toEqual([]);
    expect(r.closed).toEqual([{ agentName: "w3:p1", paneId: "w3:p1", workspace: "shop2.0", closed: "pane" }]);
    expect(closes(run)).toEqual(["pane close w3:p1"]);
  });

  test("closes the tab when the agent is alone in it", async () => {
    const { deps, run } = setup({ agents: [agent({})], tabs: { w3: [tab("w3:t1"), tab("w3:t2")] } });
    const r = await closeAgents(deps, ["w3:p1@0-0"]);
    expect(r.closed.map((c) => c.closed)).toEqual(["tab"]);
    expect(closes(run)).toEqual(["tab close w3:t1"]);
  });

  test("a tab missing from tab list closes only the pane", async () => {
    const { deps, run } = setup({ agents: [agent({})], tabs: { w3: [tab("w3:other")] } });
    await closeAgents(deps, ["w3:p1@0-0"]);
    expect(closes(run)).toEqual(["pane close w3:p1"]);
  });

  /** Two idle agents in w3, each alone in its tab; `extraTab` adds a plain terminal tab that stays. */
  function twoAgents(extraTab: boolean, herdrRemovesWorkspace = false) {
    const shut = new Set<string>();
    const wsGone = { v: false };
    const tabs = () => [tab("w3:t1"), tab("w3:t2"), ...(extraTab ? [tab("w3:tb")] : [])].filter((t) => !shut.has(t.tab_id));
    return setup(
      {
        agents: [agent({ name: "a", pane_id: "w3:p1", tab_id: "w3:t1" }), agent({ name: "b", pane_id: "w3:p2", tab_id: "w3:t2" })],
      },
      {},
      {
        "tab list": () => ok({ tabs: tabs() }),
        "tab close": (a) => {
          shut.add(a[2]);
          if (herdrRemovesWorkspace && !tabs().length) wsGone.v = true;
          return ok({ type: "ok" });
        },
        "workspace list": () => ok({ workspaces: wsGone.v ? [] : [{ ...ws("w3", "shop2.0", 1), tab_count: 3 }] }),
        "workspace close": () => {
          wsGone.v = true;
          return ok({ type: "ok" });
        },
      },
    );
  }

  test("closes the workspace once, after all its agents", async () => {
    const { deps, run } = twoAgents(false);
    const r = await closeAgents(deps, ["w3:p1@0-0", "w3:p2@0-0"]);
    expect(closes(run)).toEqual(["tab close w3:t1", "tab close w3:t2", "workspace close w3"]);
    expect(r.closed.map((c) => c.closed)).toEqual(["tab+workspace", "tab+workspace"]);
  });

  test("keeps the workspace when a plain tab remains", async () => {
    const { deps, run } = twoAgents(true);
    const r = await closeAgents(deps, ["w3:p1@0-0", "w3:p2@0-0"]);
    expect(closes(run)).toEqual(["tab close w3:t1", "tab close w3:t2"]);
    expect(r.closed.map((c) => c.closed)).toEqual(["tab", "tab"]);
  });

  test("skips workspace close when herdr already removed it", async () => {
    const { deps, run } = twoAgents(false, true);
    const r = await closeAgents(deps, ["w3:p1@0-0", "w3:p2@0-0"]);
    expect(r.refused).toEqual([]);
    expect(closes(run)).toEqual(["tab close w3:t1", "tab close w3:t2"]);
    expect(r.closed.map((c) => c.closed)).toEqual(["tab+workspace", "tab+workspace"]);
  });

  test("refuses a pane that is gone and a pane whose token changed, and still closes the rest", async () => {
    const { deps, run } = setup({
      agents: [
        agent({ name: "a", pane_id: "w3:p1", tab_id: "w3:t1", state_change_seq: 5 }),
        agent({ name: "b", pane_id: "w3:p2", tab_id: "w3:t2" }),
      ],
      tabs: { w3: [tab("w3:t1"), tab("w3:t2"), tab("w3:tb")] },
    });
    const r = await closeAgents(deps, ["w3:p9@0-0", "w3:p1@4-0", "w3:p2@0-0"]);
    expect(r.refused).toEqual([
      { pick: "w3:p9@0-0", reason: "gone" },
      { pick: "w3:p1@4-0", reason: "changed since listing" },
    ]);
    expect(r.closed.map((c) => c.paneId)).toEqual(["w3:p2"]);
    expect(closes(run)).toEqual(["tab close w3:t2"]);
  });

  test("refuses malformed, busy, working and review-stage picks with the exact reasons", async () => {
    const { deps, run } = setup(
      {
        agents: [
          agent({ name: "busy", pane_id: "w3:p1" }),
          agent({ name: "work", pane_id: "w3:p2", agent_status: "working" }),
          agent({ name: "review", pane_id: "w3:p3" }),
        ],
        procs: { "w3:p1": [{ pid: 7, name: "claude" }] },
      },
      { children: async () => [42] },
    );
    const job = newJob(deps.root, deps.reg, { slug: "x", title: "T", request: "R", projects: ["shop-api"], now: NOW });
    upsertAgent(deps.root, job.id, {
      project: "shop-api", agent: "claude", agentName: "review", workspaceId: "w3", tabId: "w3:t1",
      paneId: "w3:p3", mode: "herdr-worktree", status: "started",
    });
    setStage(deps.root, job.id, "integrate");
    const r = await closeAgents(deps, ["nonsense", "@0-0", "w3:p1@", "w3:p1@0-0", "w3:p2@0-0", "w3:p3@0-0"]);
    expect(r.closed).toEqual([]);
    expect(r.refused.map((x) => x.reason)).toEqual([
      "bad pick",
      "bad pick",
      "bad pick",
      "running child processes",
      "state working",
      `job ${job.id} waiting at integrate`,
    ]);
    expect(closes(run)).toEqual([]);
  });

  test("the same pick twice closes once", async () => {
    const { deps, run } = setup({ agents: [agent({})], tabs: { w3: [tab("w3:t1"), tab("w3:t2")] } });
    const r = await closeAgents(deps, ["w3:p1@0-0", "w3:p1@0-0"]);
    expect(r.closed).toHaveLength(1);
    expect(r.refused).toEqual([{ pick: "w3:p1@0-0", reason: "gone" }]);
    expect(closes(run)).toEqual(["tab close w3:t1"]);
  });

  test("two agents sharing a tab: the first closes its pane, the last closes the tab", async () => {
    let panes = 2;
    const { deps, run } = setup(
      { agents: [agent({ name: "a", pane_id: "w3:p1" }), agent({ name: "b", pane_id: "w3:p2" })] },
      {},
      {
        "tab list": () => ok({ tabs: [tab("w3:t1", panes), tab("w3:tb")] }),
        "pane close": () => {
          panes--;
          return ok({ type: "ok" });
        },
      },
    );
    await closeAgents(deps, ["w3:p1@0-0", "w3:p2@0-0"]);
    expect(closes(run)).toEqual(["pane close w3:p1", "tab close w3:t1"]);
  });

  test("a failed close is refused, not thrown, and the rest still close", async () => {
    const { deps } = setup(
      {
        agents: [agent({ name: "a", pane_id: "w3:p1", tab_id: "w3:t1" }), agent({ name: "b", pane_id: "w3:p2", tab_id: "w3:t2" })],
        tabs: { w3: [tab("w3:t1"), tab("w3:t2"), tab("w3:tb")] },
      },
      {},
      { "tab close": (a) => (a[2] === "w3:t1" ? { code: 1, stderr: "boom" } : ok({ type: "ok" })) },
    );
    const r = await closeAgents(deps, ["w3:p1@0-0", "w3:p2@0-0"]);
    expect(r.refused).toHaveLength(1);
    expect(r.refused[0].reason).toContain("close failed");
    expect(r.closed.map((c) => c.paneId)).toEqual(["w3:p2"]);
  });

  test("tab list failing refuses the pick instead of closing anything", async () => {
    const { deps, run } = setup({ agents: [agent({})], failTabs: true });
    const r = await closeAgents(deps, ["w3:p1@0-0"]);
    expect(r.refused).toEqual([{ pick: "w3:p1@0-0", reason: "tab info unavailable" }]);
    expect(closes(run)).toEqual([]);
  });

  test("stops a job agent and records session and folder before closing", async () => {
    const at = "2026-10-23T09:00:00Z";
    const { deps, run } = setup(
      {
        agents: [agent({ name: "api-x", cwd: "/work/api.worktrees/j1", agent_session: session("s1"), state_change_seq: 3 })],
        tabs: { w3: [tab("w3:t1"), tab("w3:t2")] },
      },
      {},
      {
        "tab close": () => {
          // by the time herdr is told to close, the job record must already say stopped
          expect(loadJob(deps.root, job.id).agents[0].status).toBe("stopped");
          return ok({ type: "ok" });
        },
      },
    );
    writeSession(deps.claudeProjects, "s1", at);
    const job = newJob(deps.root, deps.reg, { slug: "x", title: "T", request: "R", projects: ["shop-api"], now: NOW });
    upsertAgent(deps.root, job.id, {
      project: "shop-api", agent: "claude", agentName: "api-x", workspaceId: "w3", tabId: "w3:t1",
      paneId: "w3:p1", mode: "herdr-worktree", status: "started",
    });
    const r = await closeAgents(deps, [`w3:p1@3-${new Date(at).getTime()}`]);
    expect(r.refused).toEqual([]);
    expect(r.closed[0]).toMatchObject({ agentName: "api-x", jobId: job.id, closed: "tab" });
    expect(loadJob(deps.root, job.id).agents[0]).toMatchObject({
      status: "stopped",
      sessionId: "s1",
      lastCwd: "/work/api.worktrees/j1",
    });
    const log = fs.readFileSync(path.join(deps.root, "jobs", job.id, "log.md"), "utf8");
    expect(log).toContain("cleanup closed api-x (session s1, folder /work/api.worktrees/j1)");
    expect(closes(run)).toEqual(["tab close w3:t1"]);
  });

  test("a job agent without a session is logged as session none and keeps no sessionId", async () => {
    const { deps } = setup({ agents: [agent({ name: "api-x" })], tabs: { w3: [tab("w3:t1"), tab("w3:t2")] } });
    const job = newJob(deps.root, deps.reg, { slug: "x", title: "T", request: "R", projects: ["shop-api"], now: NOW });
    upsertAgent(deps.root, job.id, {
      project: "shop-api", agent: "claude", agentName: "api-x", workspaceId: "w3", tabId: "w3:t1",
      paneId: "w3:p1", mode: "herdr-worktree", status: "started",
    });
    await closeAgents(deps, ["w3:p1@0-0"]);
    expect(loadJob(deps.root, job.id).agents[0].sessionId).toBeUndefined();
    expect(fs.readFileSync(path.join(deps.root, "jobs", job.id, "log.md"), "utf8")).toContain("(session none, folder /nowhere)");
  });

  describe("a failed close leaves the job record accurate", () => {
    const rec = (o: object = {}) => ({
      project: "shop-api", agent: "claude", agentName: "api-x", workspaceId: "w3", tabId: "w3:t1",
      paneId: "w3:p1", mode: "herdr-worktree" as const, status: "started", sessionId: "old", lastCwd: "/old", ...o,
    });
    const world = (handlers: Record<string, (a: string[]) => object>) =>
      setup(
        { agents: [agent({ name: "api-x", cwd: "/new", agent_session: session("s1") })], tabs: { w3: [tab("w3:t1"), tab("w3:t2")] } },
        {},
        handlers,
      );
    const logOf = (deps: { root: string }, id: string) => fs.readFileSync(path.join(deps.root, "jobs", id, "log.md"), "utf8");

    test("herdr refusing the close restores status, session and folder, and logs why", async () => {
      const { deps } = world({ "tab close": () => ({ code: 1, stderr: "boom" }) });
      const job = newJob(deps.root, deps.reg, { slug: "x", title: "T", request: "R", projects: ["shop-api"], now: NOW });
      upsertAgent(deps.root, job.id, rec());
      const r = await closeAgents(deps, ["w3:p1@0-0"]);
      expect(r.refused[0].reason).toContain("close failed");
      expect(loadJob(deps.root, job.id).agents[0]).toEqual(rec());
      expect(logOf(deps, job.id)).toContain("cleanup could not close api-x: ");
      expect(logOf(deps, job.id)).toContain("boom");
    });

    test("restoring leaves no sessionId or lastCwd that were not there before", async () => {
      const { deps } = world({ "tab close": () => ({ code: 1, stderr: "boom" }) });
      const job = newJob(deps.root, deps.reg, { slug: "x", title: "T", request: "R", projects: ["shop-api"], now: NOW });
      upsertAgent(deps.root, job.id, rec({ sessionId: undefined, lastCwd: undefined }));
      await closeAgents(deps, ["w3:p1@0-0"]);
      const a = loadJob(deps.root, job.id).agents[0];
      expect(a.status).toBe("started");
      expect("sessionId" in a || "lastCwd" in a).toBe(false);
    });

    test("an unexpected error is undone too, then rethrown", async () => {
      const { deps } = world({ "tab close": () => { throw new Error("kaboom"); } });
      const job = newJob(deps.root, deps.reg, { slug: "x", title: "T", request: "R", projects: ["shop-api"], now: NOW });
      upsertAgent(deps.root, job.id, rec());
      await expect(closeAgents(deps, ["w3:p1@0-0"])).rejects.toThrow("kaboom");
      expect(loadJob(deps.root, job.id).agents[0]).toEqual(rec());
      expect(logOf(deps, job.id)).toContain("cleanup could not close api-x: kaboom");
    });

    test("the record is matched by agent name before pane id", async () => {
      const { deps } = world({});
      const job = newJob(deps.root, deps.reg, { slug: "x", title: "T", request: "R", projects: ["shop-api"], now: NOW });
      upsertAgent(deps.root, job.id, rec({ agentName: "older", status: "stopped" })); // same pane id, earlier agent
      upsertAgent(deps.root, job.id, rec({ agentName: "api-x" }));
      await closeAgents(deps, ["w3:p1@0-0"]);
      const byName = Object.fromEntries(loadJob(deps.root, job.id).agents.map((x) => [x.agentName, x]));
      expect(byName["api-x"]).toMatchObject({ status: "stopped", sessionId: "s1", lastCwd: "/new" });
      expect(byName.older).toMatchObject({ status: "stopped", sessionId: "old", lastCwd: "/old" });
    });
  });
});
