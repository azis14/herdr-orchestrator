import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { main } from "../orch";
import { newJob, upsertAgent } from "../src/jobs";
import { ok, testDeps, ws } from "./fakes";

describe("cli open", () => {
  test("opens with default agent", async () => {
    const { deps, out } = await testDeps();
    expect(await main(["open", "shop-api"], deps)).toBe(0);
    expect(out.join("\n")).toStartWith("opened claude (claude) in shop-api");
  });

  test("--topic labels the tab", async () => {
    const { deps, run } = testDeps();
    expect(await main(["open", "shop-api", "cursor", "--topic", "login bug"], deps)).toBe(0);
    expect(run.calls.find((c) => c[0] === "tab" && c[1] === "create")).toContain("login bug");
  });

  test("empty --topic or a stray arg is rejected", async () => {
    let t = testDeps();
    expect(await main(["open", "shop-api", "--topic", " "], t.deps)).toBe(1);
    expect(t.err.join("\n")).toContain("--topic");
    t = testDeps();
    expect(await main(["open", "shop-api", "claude", "extra"], t.deps)).toBe(1);
    expect(t.err.join("\n")).toContain("usage");
  });

  test("bash opens a terminal tab with no agent", async () => {
    const { deps, out, run } = testDeps();
    expect(await main(["bash", "shop-api", "--topic", "logs"], deps)).toBe(0);
    expect(out.join("\n")).toStartWith("opened terminal in shop-api");
    expect(run.calls.some((c) => c[0] === "agent" && c[1] === "start")).toBe(false);
  });

  test("bash rejects an agent arg or an empty --topic", async () => {
    let t = testDeps();
    expect(await main(["bash", "shop-api", "claude"], t.deps)).toBe(1);
    expect(t.err.join("\n")).toContain("usage");
    t = testDeps();
    expect(await main(["bash", "shop-api", "--topic", ""], t.deps)).toBe(1);
    expect(t.err.join("\n")).toContain("--topic");
  });

  test("code opens a project's repo, a directory path, or '.'", async () => {
    const opened: string[] = [];
    const { deps, out } = testDeps({}, { editor: async (dir) => (opened.push(dir), { code: 0, stderr: "" }) });
    expect(await main(["code", "shop-api"], deps)).toBe(0);
    expect(out.join("\n")).toStartWith("opened shop-api in VS Code");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "orch-code-"));
    expect(await main(["code", dir], deps)).toBe(0);
    expect(await main(["code", "."], deps)).toBe(0);
    expect(opened).toEqual([deps.reg.projects[0].path, dir, process.cwd()]);
  });

  test("code rejects a target that is neither a project nor a directory", async () => {
    const t = testDeps();
    expect(await main(["code", "nope-not-here"], t.deps)).toBe(1);
    expect(t.err.join("\n")).toContain("shop-api");
  });

  test("code reports a launcher failure, and needs exactly one target", async () => {
    let t = testDeps({}, { editor: async () => ({ code: 127, stderr: "code: not found" }) });
    expect(await main(["code", "shop-api"], t.deps)).toBe(1);
    expect(t.err.join("\n")).toContain("code: not found");
    t = testDeps();
    expect(await main(["code"], t.deps)).toBe(1);
    expect(t.err.join("\n")).toContain("usage");
  });

  test("unknown project returns 1 and lists known projects", async () => {
    const { deps, err } = testDeps();
    expect(await main(["open", "nope"], deps)).toBe(1);
    expect(err.join("\n")).toContain("shop-api");
  });

  test("no subcommand prints usage and returns 2", async () => {
    const { deps, err } = testDeps();
    expect(await main([], deps)).toBe(2);
    expect(err.join("\n")).toContain("usage");
  });
});

describe("cli project", () => {
  function setup() {
    const t = testDeps();
    fs.mkdirSync(path.join(t.deps.root, "registry"));
    fs.writeFileSync(path.join(t.deps.root, "registry/projects.json"), '{"projects": []}');
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), "orch-repo-"));
    fs.writeFileSync(path.join(repo, "CLAUDE.md"), "");
    return { ...t, repo, file: path.join(t.deps.root, "registry/projects.json") };
  }

  test("project add saves and prints the entry", async () => {
    const { deps, out, repo, file } = setup();
    expect(await main(["project", "add", repo, "--description", "Thing (Go)", "--context", "CLAUDE.md"], deps)).toBe(0);
    const printed = JSON.parse(out.join("\n"));
    expect(printed).toEqual({ name: path.basename(repo), path: repo, description: "Thing (Go)", context: ["CLAUDE.md"] });
    expect(JSON.parse(fs.readFileSync(file, "utf8")).projects).toEqual([printed]);
  });

  test("project add without --context saves an empty context list", async () => {
    const { deps, out, repo } = setup();
    expect(await main(["project", "add", repo, "--description", "Thing"], deps)).toBe(0);
    expect(JSON.parse(out.join("\n")).context).toEqual([]);
  });

  test("project add without --description returns 1", async () => {
    const { deps, err, repo } = setup();
    expect(await main(["project", "add", repo], deps)).toBe(1);
    expect(err.join("\n")).toContain("--description");
  });

  test("project add with more than one path returns 1 and writes nothing", async () => {
    const { deps, err, repo, file } = setup();
    expect(await main(["project", "add", repo, "extra", "--description", "x"], deps)).toBe(1);
    expect(err.join("\n")).toContain("project add");
    expect(JSON.parse(fs.readFileSync(file, "utf8")).projects).toEqual([]);
  });

  test("project add duplicate name returns 1 with the message", async () => {
    const { deps, err, repo } = setup();
    expect(await main(["project", "add", repo, "--name", "shop-api", "--description", "x"], deps)).toBe(1);
    expect(err.join("\n")).toContain("already registered");
  });

  test("project with no or unknown subcommand returns 1 with usage", async () => {
    for (const argv of [["project"], ["project", "rm"]]) {
      const { deps, err } = setup();
      expect(await main(argv, deps)).toBe(1);
      expect(err.join("\n")).toContain("project add");
    }
  });
});

describe("cli cleanup", () => {
  const NOW = new Date("2026-10-23T12:00:00Z");
  const HOUR = 3_600_000;
  const at = (hoursAgo: number) => new Date(NOW.getTime() - hoursAgo * HOUR).toISOString();

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

  function writeSession(projects: string, id: string, when: string, reply: string) {
    const file = path.join(projects, "-proj", `${id}.jsonl`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const lines = [
      { type: "user", timestamp: when, message: { content: "hi" } },
      { type: "assistant", timestamp: when, message: { content: [{ type: "text", text: reply }] } },
    ];
    fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  }

  /** `idle3h` has been idle 3h, `idle2h` 2h; both are alone in their tab of workspace w3 (3 tabs). */
  function setup() {
    const t = testDeps(
      {
        "agent list": () =>
          ok({
            agents: [
              agent({ name: "idle3h", pane_id: "w3:p1", tab_id: "w3:t1", agent_session: session("s3"), state_change_seq: 4 }),
              agent({ name: "idle2h", pane_id: "w3:p2", tab_id: "w3:t2", agent_session: session("s2"), state_change_seq: 5 }),
            ],
          }),
        "workspace list": () => ok({ workspaces: [{ ...ws("w3", "shop2.0", 1), tab_count: 3 }] }),
        "tab list": () =>
          ok({
            tabs: ["w3:t1", "w3:t2", "w3:t3"].map((id) => ({ tab_id: id, workspace_id: "w3", label: id, pane_count: 1 })),
          }),
        "pane process-info": (a) =>
          ok({ process_info: { pane_id: a[3], shell_pid: 1, foreground_processes: [] } }),
        "agent read": () => ({ stdout: "" }),
        "pane close": () => ok({ type: "ok" }),
        "tab close": () => ok({ type: "ok" }),
      },
      { now: () => NOW },
    );
    writeSession(t.deps.claudeProjects, "s3", at(3), "Shipped it.");
    writeSession(t.deps.claudeProjects, "s2", at(2), "Which one?");
    return t;
  }
  const pick3 = `w3:p1@4-${new Date(at(3)).getTime()}`;
  const pick2 = `w3:p2@5-${new Date(at(2)).getTime()}`;
  const closeCalls = (run: { calls: string[][] }) => run.calls.filter((c) => c[1] === "close").map((c) => c.join(" "));

  test("cleanup lists candidates with picks and the footer", async () => {
    const { deps, out, run } = setup();
    expect(await main(["cleanup"], deps)).toBe(0);
    const lines = out.join("\n").split("\n");
    expect(lines[0].split(/\s+/)).toEqual(["AGENT", "WORKSPACE", "IDLE", "JOB", "CLOSES", "PICK"]);
    expect(lines[1].split(/\s+/)).toEqual(["idle3h", "shop2.0", "3h", "-", "tab", pick3]);
    expect(lines[2]).toBe('  "Shipped it."');
    expect(lines[3].split(/\s+/)).toEqual(["idle2h", "shop2.0", "2h", "-", "tab", pick2]);
    expect(lines[4]).toBe('  "Which one?"');
    expect(lines.at(-1)).toBe(
      "note: scheduled wakeups, /loop and Monitor waits can't be detected; check before approving.",
    );
    expect(closeCalls(run)).toEqual([]);
  });

  test("cleanup shows skipped agents, and says so when nothing is dormant", async () => {
    const { deps, out } = setup();
    expect(await main(["cleanup", "--idle", "1d"], deps)).toBe(0);
    const text = out.join("\n");
    expect(text).toStartWith("no dormant agents\nskipped:\n");
    expect(text).toContain("  idle3h (shop2.0): active 3h ago");
    expect(text).toContain("  idle2h (shop2.0): active 2h ago");
    expect(text).not.toContain("AGENT");
  });

  test("cleanup --idle 3h passes 3h (an agent idle 2h is now skipped)", async () => {
    const { deps, out } = setup();
    expect(await main(["cleanup", "--idle", "3h"], deps)).toBe(0);
    const text = out.join("\n");
    expect(text).toContain(pick3);
    expect(text).not.toContain(pick2);
    expect(text).toContain("  idle2h (shop2.0): active 2h ago");
  });

  test("cleanup --idle 5x is rejected", async () => {
    const { deps, err } = setup();
    expect(await main(["cleanup", "--idle", "5x"], deps)).toBe(1);
    expect(err.join("\n")).toContain('bad --idle "5x"');
  });

  test("cleanup rejects an unknown workspace label, and filters by a known one", async () => {
    let t = setup();
    expect(await main(["cleanup", "nope"], t.deps)).toBe(1);
    expect(t.err.join("\n")).toContain("shop2.0");
    t = setup();
    expect(await main(["cleanup", "shop2.0"], t.deps)).toBe(0);
    expect(t.out.join("\n")).toContain(pick3);
  });

  test("cleanup --close closes and reports", async () => {
    const { deps, out, run } = setup();
    expect(await main(["cleanup", "--close", pick3, pick2], deps)).toBe(0);
    expect(out).toEqual([
      "closed idle3h (shop2.0): tab",
      "closed idle2h (shop2.0): tab",
    ]);
    expect(closeCalls(run)).toEqual(["tab close w3:t1", "tab close w3:t2"]);
  });

  test("cleanup --close reports refusals alongside closes and exits 0", async () => {
    const { deps, out } = setup();
    expect(await main(["cleanup", "--close", pick3, "w3:p9@1-1"], deps)).toBe(0);
    expect(out).toEqual(["closed idle3h (shop2.0): tab", "not closed w3:p9@1-1: gone"]);
  });

  test("cleanup --close with only refusals exits 1", async () => {
    const { deps, out, run } = setup();
    expect(await main(["cleanup", "--close", "w3:p1@4-1", "junk"], deps)).toBe(1);
    expect(out).toEqual([
      "not closed w3:p1@4-1: changed since listing",
      "not closed junk: bad pick",
    ]);
    expect(closeCalls(run)).toEqual([]);
  });

  test("cleanup --close notes the job it stopped", async () => {
    const { deps, out } = setup();
    const job = newJob(deps.root, deps.reg, { slug: "x", title: "T", request: "R", projects: ["shop-api"], now: NOW });
    upsertAgent(deps.root, job.id, {
      project: "shop-api", agent: "claude", agentName: "idle3h", workspaceId: "w3", tabId: "w3:t1",
      paneId: "w3:p1", mode: "herdr-worktree", status: "started",
    });
    expect(await main(["cleanup", "--close", pick3], deps)).toBe(0);
    expect(out).toEqual([`closed idle3h (shop2.0): tab, job ${job.id} stopped`]);
  });

  test("cleanup --close needs picks and rejects workspace args or --idle", async () => {
    for (const argv of [
      ["cleanup", "--close"],
      ["cleanup", "shop2.0", "--close", pick3],
      ["cleanup", "--close", pick3, "--idle", "2h"],
    ]) {
      const { deps, err, run } = setup();
      expect(await main(argv, deps)).toBe(1);
      expect(err.join("\n")).toContain("usage");
      expect(closeCalls(run)).toEqual([]);
    }
  });

  test("cleanup --json is parseable", async () => {
    const { deps, out } = setup();
    expect(await main(["cleanup", "--json", "--idle", "150m"], deps)).toBe(0);
    const j = JSON.parse(out.join("\n"));
    expect(j.candidates.map((c: { pick: string }) => c.pick)).toEqual([pick3]);
    expect(j.candidates[0]).toMatchObject({ agentName: "idle3h", workspace: "shop2.0", idleMs: 3 * HOUR, closes: "tab" });
    expect(j.skipped).toMatchObject([{ agentName: "idle2h", reason: "active 2h ago" }]);
  });

  test("a long last message is cut from the front to 100 characters; --json keeps it all", async () => {
    const { deps, out } = setup();
    const long = `${"x".repeat(150)} so which do you want?`;
    writeSession(deps.claudeProjects, "s3", at(3), long);
    expect(await main(["cleanup"], deps)).toBe(0);
    const shown = out.join("\n").split("\n").find((l) => l.includes("so which"))!;
    expect(shown).toBe(`  "…${long.slice(-99)}"`);
    expect(shown.length).toBe(2 + 1 + 100 + 1);
    out.length = 0;
    expect(await main(["cleanup", "--json"], deps)).toBe(0);
    expect(JSON.parse(out.join("\n")).candidates[0].lastMessage).toBe(long);
  });

  test("a message of exactly 100 characters is not cut", async () => {
    const { deps, out } = setup();
    writeSession(deps.claudeProjects, "s3", at(3), "y".repeat(100));
    expect(await main(["cleanup"], deps)).toBe(0);
    expect(out.join("\n")).toContain(`  "${"y".repeat(100)}"`);
  });

  test("rows are oldest first, with unknown ages last", async () => {
    const { deps, out } = setup();
    fs.rmSync(path.join(deps.claudeProjects, "-proj", "s3.jsonl")); // idle3h now has no transcript
    expect(await main(["cleanup"], deps)).toBe(0);
    const rows = out.join("\n").split("\n").filter((l) => /^idle/.test(l)).map((l) => l.split(/\s+/)[0]);
    expect(rows).toEqual(["idle2h", "idle3h"]);
    const { deps: d2, out: o2 } = setup();
    await main(["cleanup"], d2);
    expect(o2.join("\n").split("\n").filter((l) => /^idle/.test(l)).map((l) => l.split(/\s+/)[0])).toEqual(["idle3h", "idle2h"]);
  });

  test("an agent with no transcript shows IDLE unknown", async () => {
    const { deps, out } = setup();
    fs.rmSync(deps.claudeProjects, { recursive: true });
    expect(await main(["cleanup"], deps)).toBe(0);
    expect(out.join("\n").split("\n")[1].split(/\s+/).slice(0, 3)).toEqual(["idle2h", "shop2.0", "unknown"]);
  });
});
