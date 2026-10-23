import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { findDormant, formatAge } from "../src/cleanup";
import { OrchError } from "../src/errors";
import { newJob, setStage, upsertAgent } from "../src/jobs";
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
}

function setup(w: World, overrides = {}) {
  return testDeps(
    {
      "agent list": () => ok({ agents: w.agents ?? [] }),
      "workspace list": () =>
        ok({ workspaces: w.workspaces ?? [{ ...ws("w3", "shop2.0", 1), tab_count: 3 }] }),
      "tab list": (a) =>
        ok({
          tabs: w.tabs?.[a[3]] ?? [{ tab_id: "w3:t1", workspace_id: a[3], label: "t", pane_count: 1 }],
        }),
      "pane process-info": (a) =>
        ok({ process_info: { pane_id: a[3], shell_pid: 1, foreground_processes: w.procs?.[a[3]] ?? [] } }),
      "agent read": () => ({ stdout: w.read ?? "" }),
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
});
