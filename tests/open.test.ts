import { describe, expect, test } from "bun:test";
import { OrchError } from "../src/errors";
import { Herdr } from "../src/herdr";
import { nextAgentName, openProject, toAgentName } from "../src/open";
import { fakeRunner, ok, testRegistry, ws, type FakeHandler } from "./fakes";

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
  test("existing workspace gets a new tab", async () => {
    const reg = testRegistry();
    const p = reg.projects[0].path;
    const run = runner([ws("w5", "shop-api", 2)]);
    const r = await openProject(new Herdr(run), reg, "shop-api");
    expect(callsOf(run, "tab create")[0]).toEqual([
      "tab", "create", "--workspace", "w5", "--cwd", p, "--label", "shop-api-claude-1", "--no-focus",
    ]);
    expect(callsOf(run, "workspace create")).toHaveLength(0);
    expect(callsOf(run, "agent start")[0]).toEqual([
      "agent", "start", "shop-api-claude-1", "--kind", "claude", "--pane", "w5:p9",
    ]);
    expect(r).toEqual({
      project: "shop-api",
      agent: "claude",
      agentName: "shop-api-claude-1",
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

  test("name collision takes the next free number", async () => {
    const reg = testRegistry();
    const run = runner([ws("w5", "shop-api", 2)], {}, [{ name: "shop-api-claude-1", agent: "claude", pane_id: "w5:p1" }]);
    expect((await openProject(new Herdr(run), reg, "shop-api")).agentName).toBe("shop-api-claude-2");
  });

  test("cursor uses kind cursor and openArgs (none)", async () => {
    const reg = testRegistry();
    const run = runner([ws("w5", "shop-api", 2)]);
    const r = await openProject(new Herdr(run), reg, "shop-api", "cursor");
    const start = callsOf(run, "agent start")[0];
    expect(start).toContain("cursor");
    expect(start).not.toContain("--");
    expect(r.agentName).toBe("shop-api-cursor-1");
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
  });

  test("label match is exact", async () => {
    const reg = testRegistry();
    const run = runner([ws("w2", "shop-api-old", 1)]);
    const r = await openProject(new Herdr(run), reg, "shop-api");
    expect(r.createdWorkspace).toBe(true);
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

  test("nextAgentName stays valid with its numeric suffix", () => {
    expect(nextAgentName("shop2.0-claude", [])).toBe("shop2-0-claude-1");
    const n = nextAgentName("a".repeat(40), []);
    expect(n).toMatch(valid);
    expect(n.endsWith("-1")).toBe(true);
  });

  test("open on a project with a dot in its name starts a valid agent name", async () => {
    const reg = testRegistry(["shop2.0"]);
    const run = runner([ws("w3", "shop2.0", 1)]);
    const r = await openProject(new Herdr(run), reg, "shop2.0");
    expect(r.agentName).toBe("shop2-0-claude-1");
    expect(r.workspaceId).toBe("w3");
  });
});
