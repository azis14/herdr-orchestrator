import { describe, expect, test } from "bun:test";
import { Herdr, HerdrError } from "../src/herdr";
import { fakeRunner } from "./fakes";

const ok = (result: unknown) => ({ stdout: { id: "cli:x", result } });

describe("Herdr", () => {
  test("createTab passes exact args and parses ids", async () => {
    const run = fakeRunner({
      "tab create": () => ok({ tab: { tab_id: "w3:t9" }, root_pane: { pane_id: "w3:p9" } }),
    });
    const placement = await new Herdr(run).createTab("w3", "/r", "x");
    expect(run.calls[0]).toEqual(["tab", "create", "--workspace", "w3", "--cwd", "/r", "--label", "x", "--no-focus"]);
    expect(placement).toEqual({ workspaceId: "w3", tabId: "w3:t9", paneId: "w3:p9" });
  });

  test("createWorkspace parses workspace, tab and root pane", async () => {
    const run = fakeRunner({
      "workspace create": () =>
        ok({ workspace: { workspace_id: "w7" }, tab: { tab_id: "w7:t1" }, root_pane: { pane_id: "w7:p1" } }),
    });
    const placement = await new Herdr(run).createWorkspace("/r", "shop-api");
    expect(run.calls[0]).toEqual(["workspace", "create", "--cwd", "/r", "--label", "shop-api", "--no-focus"]);
    expect(placement).toEqual({ workspaceId: "w7", tabId: "w7:t1", paneId: "w7:p1" });
  });

  test("startAgent appends native args after --", async () => {
    const run = fakeRunner({ "agent start": () => ok({}) });
    const h = new Herdr(run);
    await h.startAgent("n", "cursor", "w3:p9", ["--force"]);
    expect(run.calls[0]).toEqual(["agent", "start", "n", "--kind", "cursor", "--pane", "w3:p9", "--", "--force"]);
    await h.startAgent("n", "claude", "w3:p9", []);
    expect(run.calls[1]).toEqual(["agent", "start", "n", "--kind", "claude", "--pane", "w3:p9"]);
    expect(run.calls[1]).not.toContain("--");
  });

  test("createWorktree adds --trust-repository only when trust", async () => {
    const run = fakeRunner({
      "worktree create": () =>
        ok({ workspace: { workspace_id: "w8" }, tab: { tab_id: "w8:t1" }, root_pane: { pane_id: "w8:p1" } }),
    });
    const h = new Herdr(run);
    const o = { cwd: "/r", branch: "feature/x", base: "origin/dev", path: "/r.worktrees/x", label: "r:x" };
    await h.createWorktree({ ...o, trust: false });
    await h.createWorktree({ ...o, trust: true });
    expect(run.calls[0]).toEqual([
      "worktree", "create", "--cwd", "/r", "--branch", "feature/x", "--base", "origin/dev",
      "--path", "/r.worktrees/x", "--label", "r:x", "--no-focus",
    ]);
    expect(run.calls[1].at(-1)).toBe("--trust-repository");
  });

  test("list calls unwrap result arrays", async () => {
    const run = fakeRunner({
      "workspace list": () => ok({ workspaces: [{ workspace_id: "w1", label: "a", number: 1, focused: true }] }),
      "agent list": () => ok({ agents: [{ agent: "claude", pane_id: "w1:p1" }] }),
    });
    const h = new Herdr(run);
    expect((await h.listWorkspaces())[0].workspace_id).toBe("w1");
    expect((await h.listAgents())[0].pane_id).toBe("w1:p1");
  });

  test("server error becomes HerdrError", async () => {
    const run = fakeRunner({
      "agent start": () => ({ code: 1, stderr: { error: { code: "agent_not_ready", message: "m" } } }),
      "tab create": () => ({ code: 2, stderr: "raw failure text" }),
    });
    const h = new Herdr(run);
    const e1 = await h.startAgent("n", "claude", "p", []).catch((e) => e);
    expect(e1).toBeInstanceOf(HerdrError);
    expect(e1.code).toBe("agent_not_ready");
    expect(e1.message).toContain("m");
    const e2 = await h.createTab("w", "/r", "x").catch((e) => e);
    expect(e2).toBeInstanceOf(HerdrError);
    expect(e2.message).toContain("raw failure text");
  });

  test("listTabs passes the workspace and returns the tabs", async () => {
    const tab = { tab_id: "w3:t2", workspace_id: "w3", label: "x", pane_count: 2 };
    const run = fakeRunner({ "tab list": () => ok({ tabs: [tab] }) });
    expect(await new Herdr(run).listTabs("w3")).toEqual([tab]);
    expect(run.calls[0]).toEqual(["tab", "list", "--workspace", "w3"]);
  });

  test("processPids keeps only pids of processes with the given name", async () => {
    const run = fakeRunner({
      "pane process-info": () =>
        ok({
          process_info: {
            pane_id: "w3:p1",
            shell_pid: 1,
            foreground_processes: [
              { pid: 10, name: "claude", cwd: "/r" },
              { pid: 11, name: "node", cwd: "/r" },
              { pid: 12, name: "claude", cwd: "/r" },
            ],
          },
        }),
    });
    expect(await new Herdr(run).processPids("w3:p1", "claude")).toEqual([10, 12]);
    expect(run.calls[0]).toEqual(["pane", "process-info", "--pane", "w3:p1"]);
  });

  test("processPids falls back to every foreground pid when none matches the name", async () => {
    const run = fakeRunner({
      "pane process-info": () =>
        ok({
          process_info: {
            pane_id: "w3:p1",
            shell_pid: 1,
            foreground_processes: [
              { pid: 20, name: "node", cwd: "/r" },
              { pid: 21, name: "rg", cwd: "/r" },
            ],
          },
        }),
    });
    expect(await new Herdr(run).processPids("w3:p1", "cursor")).toEqual([20, 21]);
  });

  test("processPids throws when the reply has no foreground_processes", async () => {
    const run = fakeRunner({ "pane process-info": () => ok({ process_info: { pane_id: "w3:p1" } }) });
    const e = await new Herdr(run).processPids("w3:p1", "claude").catch((e) => e);
    expect(e).toBeInstanceOf(HerdrError);
    const run2 = fakeRunner({ "pane process-info": () => ok({}) });
    expect(await new Herdr(run2).processPids("w3:p1", "claude").catch((e) => e)).toBeInstanceOf(HerdrError);
  });

  test("readAgent returns raw stdout and throws HerdrError on failure", async () => {
    const run = fakeRunner({ "agent read": (a) => (a[2] === "gone" ? { code: 1, stderr: "no such pane" } : { stdout: "line 1\nline 2\n" }) });
    const h = new Herdr(run);
    expect(await h.readAgent("w3:p1", 20)).toBe("line 1\nline 2\n");
    expect(run.calls[0]).toEqual(["agent", "read", "w3:p1", "--lines", "20"]);
    const e = await h.readAgent("gone", 20).catch((e) => e);
    expect(e).toBeInstanceOf(HerdrError);
    expect(e.message).toContain("no such pane");
  });

  test("close methods run pane, tab and workspace close", async () => {
    const run = fakeRunner({
      "pane close": () => ok({ type: "ok" }),
      "tab close": () => ok({ type: "ok" }),
      "workspace close": () => ok({ type: "ok" }),
    });
    const h = new Herdr(run);
    await h.closePane("w3:p1");
    await h.closeTab("w3:t1");
    await h.closeWorkspace("w3");
    expect(run.calls).toEqual([
      ["pane", "close", "w3:p1"],
      ["tab", "close", "w3:t1"],
      ["workspace", "close", "w3"],
    ]);
  });
});
