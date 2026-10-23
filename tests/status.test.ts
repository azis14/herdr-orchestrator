import { describe, expect, test } from "bun:test";
import { main } from "../orch";
import type { AgentInfo } from "../src/herdr";
import type { Job } from "../src/jobs";
import type { Registry } from "../src/registry";
import { buildStatus, formatStatus, type StatusRow } from "../src/status";
import { ok, testDeps } from "./fakes";

const reg: Registry = {
  defaultAgent: "claude",
  agents: [{ name: "claude", kind: "claude", openArgs: [], jobArgs: [] }],
  projects: [
    { name: "shop-api", path: "/home/user/repos/shop-api", description: "", context: [] },
    { name: "shop-ui", path: "/home/user/repos/shop-ui", description: "", context: [] },
  ],
};

const info = (pane_id: string, cwd: string, name?: string): AgentInfo => ({
  name,
  agent: "claude",
  agent_status: "idle",
  cwd,
  pane_id,
  tab_id: pane_id.replace(":p", ":t"),
  workspace_id: pane_id.split(":")[0],
});

const job = (stage: Job["stage"], paneId: string, agentName = "j-shop-api"): Job => ({
  id: "20261023-x",
  title: "X",
  request: "",
  projects: ["shop-api"],
  stage,
  createdAt: "2026-10-23T00:00:00.000Z",
  agents: [
    {
      project: "shop-api",
      agent: "claude",
      agentName,
      workspaceId: "w9",
      tabId: "w9:t1",
      paneId,
      mode: "herdr-worktree",
      status: "started",
    },
  ],
});

describe("status", () => {
  test("prefix safety: sibling dirs don't match, worktrees and subdirs do", () => {
    const rows = buildStatus(
      [
        info("w1:p1", "/home/user/repos/shop-api-old", "a"),
        info("w1:p2", "/home/user/repos/shop-api.worktrees/20261023-x", "b"),
        info("w1:p3", "/home/user/repos/shop-api/src", "c"),
      ],
      reg,
      [],
    );
    expect(Object.fromEntries(rows.map((r) => [r.agentName, r.project]))).toEqual({
      a: null,
      b: "shop-api",
      c: "shop-api",
    });
  });

  test("job tagging by pane; done jobs don't tag", () => {
    const agents = [info("w9:p1", "/home/user/repos/shop-api", "x")];
    expect(buildStatus(agents, reg, [job("plan", "w9:p1")])[0]).toMatchObject({ jobId: "20261023-x", stage: "plan" });
    expect(buildStatus(agents, reg, [job("done", "w9:p1")])[0].jobId).toBeUndefined();
  });

  test("job tagging by agent name when the pane differs", () => {
    const agents = [info("w9:p5", "/home/user/repos/shop-api", "j-shop-api")];
    expect(buildStatus(agents, reg, [job("build", "w9:p1")])[0].jobId).toBe("20261023-x");
  });

  test("unnamed agent uses pane id; sorted by project with unregistered last", () => {
    const rows = buildStatus(
      [info("w1:p9", "/tmp"), info("w1:p2", "/home/user/repos/shop-ui", "u"), info("w1:p3", "/home/user/repos/shop-api", "z")],
      reg,
      [],
    );
    expect(rows.map((r) => r.agentName)).toEqual(["z", "u", "w1:p9"]);
  });

  test("formatStatus shows (unregistered) and -", () => {
    const text = formatStatus(buildStatus([info("w1:p9", "/tmp")], reg, []));
    const [header, row] = text.split("\n");
    expect(header.split(/\s+/)).toEqual(["AGENT", "PROJECT", "KIND", "STATE", "PANE", "JOB"]);
    expect(row).toContain("(unregistered)");
    expect(row.trim().endsWith("-")).toBe(true);
  });

  test("cli status --json prints StatusRow[]", async () => {
    const { deps, out } = testDeps({
      "agent list": () => ok({ agents: [info("w1:p1", "/tmp", "a")] }),
    });
    expect(await main(["status", "--json"], deps)).toBe(0);
    const rows: StatusRow[] = JSON.parse(out.join("\n"));
    expect(rows[0]).toMatchObject({ agentName: "a", project: null, kind: "claude", state: "idle", paneId: "w1:p1" });
  });
});
