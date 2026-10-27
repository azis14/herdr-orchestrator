import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { main } from "../orch";
import { OrchError } from "../src/errors";
import { newJob, upsertAgent } from "../src/jobs";
import { claudeDirName } from "../src/sessions";
import type { GitRunner } from "../src/git";
import type { Registry } from "../src/registry";
import { fakeForge, ok, testDeps, testRegistry, ws } from "./fakes";

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
    let apiPath = "/nowhere"; // idle2h works in the registered shop-api checkout, idle3h in an unregistered folder
    const t = testDeps(
      {
        "agent list": () =>
          ok({
            agents: [
              agent({ name: "idle3h", pane_id: "w3:p1", tab_id: "w3:t1", agent_session: session("s3"), state_change_seq: 4 }),
              agent({ name: "idle2h", cwd: apiPath, pane_id: "w3:p2", tab_id: "w3:t2", agent_session: session("s2"), state_change_seq: 5 }),
            ],
          }),
        "workspace list": () => ok({ workspaces: [{ ...ws("w3", "shop2.0", 1), tab_count: 3 }] }),
        "tab list": () =>
          ok({
            tabs: ["w3:t1", "w3:t2", "w3:t3"].map((id) => ({ tab_id: id, workspace_id: "w3", label: id, pane_count: 1 })),
          }),
        "pane process-info": (a) =>
          ok({ process_info: { pane_id: a[3], shell_pid: 1, foreground_processes: [{ pid: 1, name: "claude" }] } }),
        "agent read": () => ({ stdout: "" }),
        "pane close": () => ok({ type: "ok" }),
        "tab close": () => ok({ type: "ok" }),
      },
      { now: () => NOW },
    );
    apiPath = t.deps.reg.projects[0].path;
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
    expect(lines[0].split(/\s+/)).toEqual(["AGENT", "WORKSPACE", "PROJECT", "IDLE", "JOB", "CLOSES", "PICK"]);
    expect(lines[1].split(/\s+/)).toEqual(["idle3h", "shop2.0", "-", "3h", "-", "tab", pick3]);
    expect(lines[2]).toBe('  "Shipped it."');
    expect(lines[3].split(/\s+/)).toEqual(["idle2h", "shop2.0", "shop-api", "2h", "-", "tab", pick2]);
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
    expect(out.join("\n").split("\n")[1].split(/\s+/).slice(0, 4)).toEqual(["idle2h", "shop2.0", "shop-api", "unknown"]);
  });
});

describe("cli registry", () => {
  test("a command that needs the registry reports a missing one", async () => {
    const t = testDeps();
    Object.defineProperty(t.deps, "reg", {
      get: () => {
        throw new OrchError("no registry yet (missing registry/agents.json): run /setup first");
      },
    });
    expect(await main(["status"], t.deps)).toBe(1);
    expect(t.err.join("\n")).toContain("run /setup first");
  });
});

describe("cli listings", () => {
  test("folders --json starts with the base folder", async () => {
    const { deps, out } = testDeps();
    expect(await main(["folders", "shop-api", "--json"], deps)).toBe(0);
    const rows = JSON.parse(out.join("\n"));
    expect(rows[0]).toMatchObject({ path: deps.reg.projects[0].path, base: true, sessions: 0, lastUsed: null });
  });

  test("folders text names the base folder", async () => {
    const { deps, out } = testDeps();
    expect(await main(["folders", "shop-api"], deps)).toBe(0);
    expect(out.join("\n")).toContain("base");
  });

  test("sessions refuses a folder that isn't the project's", async () => {
    const { deps, err } = testDeps();
    expect(await main(["sessions", "shop-api", "--folder", "/nope"], deps)).toBe(1);
    expect(err.join("\n")).toContain("is not a folder of shop-api");
  });

  test("sessions --json on an empty folder is an empty list", async () => {
    const { deps, out } = testDeps();
    expect(await main(["sessions", "shop-api", "cursor", "--json"], deps)).toBe(0);
    expect(JSON.parse(out.join("\n"))).toEqual([]);
  });

  test("project list --json lists every project", async () => {
    const { deps, out } = testDeps();
    expect(await main(["project", "list", "--json"], deps)).toBe(0);
    expect(JSON.parse(out.join("\n")).map((p: { name: string }) => p.name)).toEqual(["shop-api", "shop-ui"]);
  });

  test("project usage mentions list", async () => {
    const { deps, err } = testDeps();
    expect(await main(["project", "frobnicate"], deps)).toBe(1);
    expect(err.join("\n")).toContain("project list");
  });
});

describe("cli open/bash folders and sessions", () => {
  test("--continue and --resume together are refused", async () => {
    const { deps, err } = testDeps();
    expect(await main(["open", "shop-api", "--continue", "--resume", "s1"], deps)).toBe(1);
    expect(err.join("\n")).toContain("--continue and --resume can't be used together");
  });

  test("open --continue names the session and where else it's open", async () => {
    const { deps, out } = testDeps({
      "agent list": () =>
        ok({ agents: [{ name: "claude-3", agent: "claude", agent_status: "idle", cwd: "/x", pane_id: "w5:p3", tab_id: "w5:t3", workspace_id: "w5", agent_session: { value: "s1" } }] }),
    });
    const p = deps.reg.projects[0].path;
    const dir = path.join(deps.claudeProjects, claudeDirName(p));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "s1.jsonl"),
      JSON.stringify({ type: "user", cwd: p, timestamp: "2026-10-01T00:00:00Z", message: { content: "Fix tax" } }) + "\n",
    );
    expect(await main(["open", "shop-api", "--continue"], deps)).toBe(0);
    expect(out.join("\n")).toContain(`resumed "Fix tax" (s1) (also open in shop-api tab w5:t3)`);
  });

  test("bash --folder opens there; a foreign folder is refused", async () => {
    let t = testDeps();
    const base = t.deps.reg.projects[0].path;
    const wt = fs.mkdtempSync(path.join(os.tmpdir(), "orch-wt-"));
    const git = async () => ({ code: 0, stdout: `worktree ${base}\nHEAD 1\nbranch refs/heads/dev\n\nworktree ${wt}\nHEAD 2\nbranch refs/heads/x\n`, stderr: "" });
    t.deps.git = git;
    expect(await main(["bash", "shop-api", "--folder", wt], t.deps)).toBe(0);
    expect(t.run.calls.find((c) => c[0] === "tab" && c[1] === "create")).toContain(wt);
    expect(t.out.join("\n")).toContain(`folder ${wt}`);
    t = testDeps();
    t.deps.git = git;
    expect(await main(["bash", "shop-api", "--folder", "/tmp"], t.deps)).toBe(1);
  });
});

describe("cli mr", () => {
  /** A git whose origin exists only in the registry's first project. */
  const originFor =
    (reg: Registry, origin: string): GitRunner =>
    async (cwd, args) =>
      args.join(" ") === "remote get-url origin" && cwd === reg.projects[0].path
        ? { code: 0, stdout: `${origin}\n`, stderr: "" }
        : { code: 128, stdout: "", stderr: "no origin" };

  test("mr show --json prints MrInfo", async () => {
    const reg = testRegistry();
    const t = testDeps({}, {
      reg,
      git: originFor(reg, "git@github.com:acme/shop.git"),
      forge: fakeForge({
        "GET repos/acme/shop/pulls/9": () => ({
          stdout: {
            html_url: "https://github.com/acme/shop/pull/9",
            node_id: "PR_9",
            title: "Fix cart",
            body: "",
            user: { login: "bob" },
            state: "open",
            merged: false,
            draft: false,
            head: { ref: "fix/cart", sha: "abc", repo: { full_name: "acme/shop" } },
            base: { ref: "dev", sha: "def", repo: { full_name: "acme/shop", default_branch: "main" } },
          },
        }),
        "GET user": () => ({ stdout: { login: "me" } }),
      }),
    });
    expect(await main(["mr", "show", "--json", "https://github.com/acme/shop/pull/9"], t.deps)).toBe(0);
    const mr = JSON.parse(t.out.join("\n"));
    expect(mr).toMatchObject({ kind: "pr", number: 9, project: "shop-api", head: "abc", nodeId: "PR_9", base: null });
  });

  test("mr show prints a one-line summary", async () => {
    const reg = testRegistry();
    const t = testDeps({}, {
      reg,
      git: originFor(reg, "git@gitlab.x.io:g/p.git"),
      forge: fakeForge({
        "GET projects/g%2Fp/merge_requests/3": () => ({
          stdout: { web_url: "https://gitlab.x.io/g/p/-/merge_requests/3", title: "T", state: "opened", source_project_id: 1, target_project_id: 1, source_branch: "feat", target_branch: "dev", sha: "h" },
        }),
        "GET projects/g%2Fp": () => ({ stdout: { default_branch: "main" } }),
        "GET user": () => ({ stdout: { username: "me" } }),
      }),
    });
    expect(await main(["mr", "show", "shop-api", "3"], t.deps)).toBe(0);
    expect(t.out).toEqual(["mr 3 open feat → dev https://gitlab.x.io/g/p/-/merge_requests/3"]);
  });

  test("mr threads prints a count line, and --json prints the threads", async () => {
    const reg = testRegistry();
    const mk = () =>
      testDeps({}, {
        reg,
        git: originFor(reg, "git@gitlab.x.io:g/p.git"),
        forge: fakeForge({
          "GET projects/g%2Fp/merge_requests/3": () => ({
            stdout: { web_url: "https://gitlab.x.io/g/p/-/merge_requests/3", title: "T", state: "opened", source_project_id: 1, target_project_id: 1, source_branch: "feat", target_branch: "dev", sha: "h" },
          }),
          "GET projects/g%2Fp": () => ({ stdout: { default_branch: "main" } }),
          "GET user": () => ({ stdout: { username: "me" } }),
          "GET projects/g%2Fp/merge_requests/3/discussions": () => ({
            stdout: [
              { id: "d1", notes: [{ id: 1, body: "x", author: { username: "a" }, created_at: "t", system: false, resolvable: true, resolved: false }] },
              { id: "d2", notes: [{ id: 2, body: "y", author: { username: "a" }, created_at: "t", system: false, resolvable: false }] },
            ],
          }),
        }),
      });
    const plain = mk();
    expect(await main(["mr", "threads", "shop-api", "3"], plain.deps)).toBe(0);
    expect(plain.out).toEqual(["mr 3: 1 threads (1 unresolved), 1 notes"]);
    const json = mk();
    expect(await main(["mr", "threads", "shop-api", "3", "--json"], json.deps)).toBe(0);
    const r = JSON.parse(json.out[0]);
    expect(r.me).toBe("me");
    expect(r.threads[0].id).toBe("d1");
    expect(r.notes[0].id).toBe("2");
  });

  test("mr position exits 3 for a line outside every hunk", async () => {
    const reg = testRegistry();
    const git: GitRunner = async (cwd, args) => {
      if (args.join(" ") === "remote get-url origin") {
        return cwd === reg.projects[0].path ? { code: 0, stdout: "git@gitlab.x.io:g/p.git\n", stderr: "" } : { code: 128, stdout: "", stderr: "no origin" };
      }
      if (args[0] === "diff") return { code: 0, stdout: "@@ -1,2 +1,3 @@\n a\n+b\n c\n", stderr: "" };
      return { code: 0, stdout: "", stderr: "" };
    };
    const mk = () =>
      testDeps({}, {
        reg,
        git,
        forge: fakeForge({
          "GET projects/g%2Fp/merge_requests/3": () => ({
            stdout: { web_url: "https://gitlab.x.io/g/p/-/merge_requests/3", title: "T", state: "opened", source_project_id: 1, target_project_id: 1, source_branch: "feat", target_branch: "dev", sha: "h", diff_refs: { base_sha: "b", start_sha: "s", head_sha: "h" } },
          }),
          "GET projects/g%2Fp": () => ({ stdout: { default_branch: "main" } }),
          "GET user": () => ({ stdout: { username: "me" } }),
        }),
      });
    const outside = mk();
    expect(await main(["mr", "position", "shop-api", "3", "--path", "a.ts", "--line", "50", "--json"], outside.deps)).toBe(3);
    expect(outside.out.join("\n")).toContain('"kind": "outside"');
    const inside = mk();
    expect(await main(["mr", "position", "shop-api", "3", "--path", "a.ts", "--line", "2", "--json"], inside.deps)).toBe(0);
    expect(JSON.parse(inside.out[0])).toMatchObject({ kind: "added", line: 2 });
    const plain = mk();
    expect(await main(["mr", "position", "shop-api", "3", "--path", "a.ts", "--line", "50"], plain.deps)).toBe(3);
    expect(plain.out[0]).toContain("outside");
  });

  test("mr position needs --path and --line", async () => {
    const { deps, err } = testDeps();
    expect(await main(["mr", "position", "shop-api", "3", "--line", "2"], deps)).toBe(1);
    expect(err.join("\n")).toContain("--path");
  });

  test("mr post reads stdin and exits 3 listing outside comments", async () => {
    const reg = testRegistry();
    const git: GitRunner = async (cwd, args) => {
      if (args.join(" ") === "remote get-url origin") {
        return cwd === reg.projects[0].path ? { code: 0, stdout: "git@gitlab.x.io:g/p.git\n", stderr: "" } : { code: 128, stdout: "", stderr: "no origin" };
      }
      if (args[0] === "diff") return { code: 0, stdout: "@@ -1,2 +1,3 @@\n a\n+b\n c\n", stderr: "" };
      return { code: 0, stdout: "", stderr: "" };
    };
    const mk = (stdin: string) => {
      const forge = fakeForge({
        "GET projects/g%2Fp/merge_requests/3": () => ({
          stdout: { web_url: "https://gitlab.x.io/g/p/-/merge_requests/3", title: "T", state: "opened", source_project_id: 1, target_project_id: 1, source_branch: "feat", target_branch: "dev", sha: "h", diff_refs: { base_sha: "b", start_sha: "s", head_sha: "h" } },
        }),
        "GET projects/g%2Fp": () => ({ stdout: { default_branch: "main" } }),
        "GET user": () => ({ stdout: { username: "me" } }),
        "POST projects/g%2Fp/merge_requests/3/discussions": (_a, s) => ({ stdout: { id: "d1", notes: [{ id: 5, position: JSON.parse(s ?? "{}").position }] } }),
        "POST projects/g%2Fp/merge_requests/3/notes": () => ({ stdout: { id: 6 } }),
      });
      const posted = () => forge.calls.some((c) => c.args.includes("POST"));
      return { ...testDeps({}, { reg, git, forge, readStdin: async () => stdin }), posted };
    };
    const review = (line: number) => JSON.stringify({ summary: "## Review", comments: [{ path: "a.ts", line, body: "x" }, { path: "a.ts", line: 2, body: "y" }] });

    const outside = mk(review(50));
    expect(await main(["mr", "post", "shop-api", "3"], outside.deps)).toBe(3);
    expect(JSON.parse(outside.out.join("\n"))).toEqual({ outside: [{ path: "a.ts", line: 50, body: "x" }] });
    expect(outside.posted()).toBe(false);

    const dry = mk(review(2));
    expect(await main(["mr", "post", "shop-api", "3", "--dry-run", "--json"], dry.deps)).toBe(0);
    expect(JSON.parse(dry.out.join("\n")).comments).toHaveLength(2);
    expect(dry.posted()).toBe(false);

    const real = mk(review(2));
    expect(await main(["mr", "post", "shop-api", "3", "--json"], real.deps)).toBe(0);
    expect(JSON.parse(real.out.join("\n"))).toMatchObject({ summaryUrl: "https://gitlab.x.io/g/p/-/merge_requests/3#note_6" });
    expect(real.posted()).toBe(true);

    const plain = mk(review(2));
    expect(await main(["mr", "post", "shop-api", "3"], plain.deps)).toBe(0);
    expect(plain.out.join("\n")).toContain("placed a.ts:2");

    const bad = mk("not json");
    expect(await main(["mr", "post", "shop-api", "3"], bad.deps)).toBe(1);
    expect(bad.err.join("\n")).toContain("stdin");
    expect(bad.posted()).toBe(false);
  });

  test("mr worktree prints the fix worktree path, and --protect refuses the source branch", async () => {
    const reg = testRegistry();
    const dir = `${reg.projects[0].path}.worktrees/mr-3`;
    const git: GitRunner = async (cwd, args) => {
      const cmd = args.join(" ");
      if (cmd === "remote get-url origin") return cwd === reg.projects[0].path ? { code: 0, stdout: "git@gitlab.x.io:g/p.git\n", stderr: "" } : { code: 128, stdout: "", stderr: "no origin" };
      if (cmd === "worktree list --porcelain") return { code: 0, stdout: `worktree ${reg.projects[0].path}\nHEAD 1111\nbranch refs/heads/dev\n`, stderr: "" };
      if (args[0] === "rev-parse") return { code: 1, stdout: "", stderr: "" };
      return { code: 0, stdout: "", stderr: "" };
    };
    const forge = fakeForge({
      "GET projects/g%2Fp/merge_requests/3": () => ({
        stdout: { web_url: "https://gitlab.x.io/g/p/-/merge_requests/3", title: "T", state: "opened", source_project_id: 1, target_project_id: 1, source_branch: "feat", target_branch: "dev", sha: "h" },
      }),
      "GET projects/g%2Fp": () => ({ stdout: { default_branch: "main" } }),
      "GET user": () => ({ stdout: { username: "me" } }),
    });
    const t = testDeps({}, { reg, git, forge });
    expect(await main(["mr", "worktree", "shop-api", "3"], t.deps)).toBe(0);
    expect(t.out).toEqual([dir]);

    const j = testDeps({}, { reg, git, forge });
    expect(await main(["mr", "worktree", "shop-api", "3", "--json"], j.deps)).toBe(0);
    expect(JSON.parse(j.out.join(""))).toEqual({ path: dir, branch: "feat", created: true });

    const p = testDeps({}, { reg, git, forge });
    expect(await main(["mr", "worktree", "shop-api", "3", "--protect", "a,feat"], p.deps)).toBe(1);
    expect(p.err.join("\n")).toContain("protected");
  });

  test("mr note, reply and resolve print the url or resolved state", async () => {
    const reg = testRegistry();
    const git: GitRunner = async (cwd, args) =>
      args.join(" ") === "remote get-url origin" && cwd === reg.projects[0].path ? { code: 0, stdout: "git@gitlab.x.io:g/p.git\n", stderr: "" } : { code: 128, stdout: "", stderr: "no origin" };
    const mk = (stdin: string) => {
      const forge = fakeForge({
        "GET projects/g%2Fp/merge_requests/3": () => ({
          stdout: { web_url: "https://gitlab.x.io/g/p/-/merge_requests/3", title: "T", state: "opened", source_project_id: 1, target_project_id: 1, source_branch: "feat", target_branch: "dev", sha: "h", diff_refs: { base_sha: "b", start_sha: "s", head_sha: "h" } },
        }),
        "GET projects/g%2Fp": () => ({ stdout: { default_branch: "main" } }),
        "GET user": () => ({ stdout: { username: "me" } }),
        "GET projects/g%2Fp/merge_requests/3/discussions": () => ({ stdout: [{ id: "d1", notes: [{ id: 1, resolvable: true, resolved: false, position: { new_path: "a.ts", new_line: 1 } }] }] }),
        "POST projects/g%2Fp/merge_requests/3/notes": () => ({ stdout: { id: 6 } }),
        "POST projects/g%2Fp/merge_requests/3/discussions/d1/notes": () => ({ stdout: { id: 7 } }),
        "PUT projects/g%2Fp/merge_requests/3/discussions/d1": () => ({ stdout: { id: "d1", notes: [{ id: 1, resolved: true }] } }),
      });
      return { ...testDeps({}, { reg, git, forge, readStdin: async () => stdin }), forge };
    };
    const U = "https://gitlab.x.io/g/p/-/merge_requests/3";

    const note = mk("hi");
    expect(await main(["mr", "note", "shop-api", "3"], note.deps)).toBe(0);
    expect(note.out).toEqual([`${U}#note_6`]);

    const reply = mk("done");
    expect(await main(["mr", "reply", "shop-api", "3", "--thread", "d1", "--json"], reply.deps)).toBe(0);
    expect(JSON.parse(reply.out.join(""))).toEqual({ url: `${U}#note_7` });

    const resolve = mk("");
    expect(await main(["mr", "resolve", "shop-api", "3", "--thread", "d1"], resolve.deps)).toBe(0);
    expect(resolve.out).toEqual(["resolved: true"]);

    const noThread = mk("x");
    expect(await main(["mr", "reply", "shop-api", "3"], noThread.deps)).toBe(1);
    expect(noThread.err.join("\n")).toContain("--thread");

    const empty = mk("  ");
    expect(await main(["mr", "note", "shop-api", "3"], empty.deps)).toBe(1);
    expect(empty.err.join("\n")).toContain("empty");
    expect(empty.forge.calls).toEqual([]);
  });

  test("mr with no subcommand prints mr usage", async () => {
    const { deps, err } = testDeps();
    expect(await main(["mr"], deps)).toBe(1);
    expect(err.join("\n")).toContain("usage: mr");
  });
});
