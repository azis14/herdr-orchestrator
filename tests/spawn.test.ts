import { describe, expect, test } from "bun:test";
import { main, type GitRunner } from "../orch";
import { OrchError } from "../src/errors";
import { loadJob, newJob, patchAgent } from "../src/jobs";
import { spawnJobAgent } from "../src/spawn";
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
      "agent", "start", "shop-api-20261023-x", "--kind", "claude", "--pane", "w8:p1",
    ]);
    expect(a).toEqual({
      project: "shop-api",
      agent: "claude",
      agentName: "shop-api-20261023-x",
      workspaceId: "w8",
      tabId: "w8:t1",
      paneId: "w8:p1",
      mode: "herdr-worktree",
      worktreePath: `${api}.worktrees/20261023-x`,
      branch: "feature/20261023-x",
      status: "started",
    });
    expect(loadJob(deps.root, job.id).agents).toEqual([a]);
  });

  test("fetch failure stops before any herdr call", async () => {
    const { deps, run, job } = setup({}, 1);
    const e = await spawnJobAgent(deps, job.id, "shop-api", undefined, { repoWorktree: false, trust: false }).catch((x) => x);
    expect(e).toBeInstanceOf(OrchError);
    expect(e.message).toContain("no remote");
    expect(run.calls).toEqual([]);
  });

  test("cursor job agent gets --force", async () => {
    const { deps, run, job } = setup();
    await spawnJobAgent(deps, job.id, "shop-api", "cursor", { repoWorktree: false, trust: false });
    expect(call(run, "agent start")!.slice(-2)).toEqual(["--", "--force"]);
  });

  test("repo mode opens a tab in the main checkout without git", async () => {
    const { deps, run, job, api, gitCalls } = setup({
      "workspace list": () => ok({ workspaces: [ws("w5", "shop-api", 2)] }),
    });
    const a = await spawnJobAgent(deps, job.id, "shop-api", undefined, { repoWorktree: true, trust: false });
    expect(gitCalls).toEqual([]);
    expect(call(run, "worktree create")).toBeUndefined();
    expect(call(run, "tab create")).toContain(api);
    expect(a).toMatchObject({ mode: "repo-worktree", agentName: "shop-api-20261023-x", paneId: "w5:p9" });
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
    patchAgent(deps.root, job.id, "shop-api-20261023-x", { status: "stopped" });
    await spawnJobAgent(deps, job.id, "shop-api", undefined, o);
  });

  test("cli job spawn prints the spawned line", async () => {
    const { deps, out, job } = setup();
    expect(await main(["job", "spawn", job.id, "shop-api", "cursor"], deps)).toBe(0);
    expect(out.pop()).toBe("spawned shop-api-20261023-x (cursor, herdr-worktree) pane w8:p1");
  });
});
