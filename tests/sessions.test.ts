import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { OrchError } from "../src/errors";
import type { GitRunner } from "../src/git";
import { newJob, setStage, upsertAgent } from "../src/jobs";
import {
  claudeDirName,
  claudeFolderStats,
  claudeSessions,
  cursorDirName,
  cursorFolderStats,
  cursorSessions,
  listFolderEntries,
  listProjects,
  listSessions,
} from "../src/sessions";
import { ok, testDeps, testRegistry, ws } from "./fakes";

const tmp = (name: string) => fs.mkdtempSync(path.join(os.tmpdir(), `orch-${name}-`));

const user = (text: unknown, cwd: string, ts: string, extra: object = {}) => ({
  type: "user",
  cwd,
  timestamp: ts,
  message: { role: "user", content: text },
  ...extra,
});
const assistant = (text: string, cwd: string, ts: string, extra: object = {}) => ({
  type: "assistant",
  cwd,
  timestamp: ts,
  message: { role: "assistant", content: [{ type: "text", text }] },
  ...extra,
});

/** Writes `<root>/<claudeDirName(dirFor)>/<id>.jsonl`. */
function transcript(root: string, dirFor: string, id: string, entries: unknown[], raw: string[] = []): string {
  const dir = path.join(root, claudeDirName(dirFor));
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${id}.jsonl`);
  fs.writeFileSync(file, [...entries.map((e) => JSON.stringify(e)), ...raw].join("\n") + "\n");
  return file;
}

describe("claudeDirName", () => {
  test("every non-alphanumeric becomes '-'", () => {
    expect(claudeDirName("/home/azis/repos/aura2.0-monorepo")).toBe("-home-azis-repos-aura2-0-monorepo");
  });
});

describe("claudeSessions", () => {
  const F = "/r/shop";

  test("title prefers custom-title, then ai-title, then the first prompt", () => {
    const root = tmp("claude");
    transcript(root, F, "s-custom", [
      user("hello", F, "2026-10-20T07:00:00Z"),
      { type: "ai-title", aiTitle: "Robot title" },
      { type: "custom-title", customTitle: "Mine" },
    ]);
    transcript(root, F, "s-ai", [user("hello", F, "2026-10-20T08:00:00Z"), { type: "ai-title", aiTitle: "Fix tax" }]);
    transcript(root, F, "s-prompt", [
      user("<local-command-caveat>Caveat: ignore</local-command-caveat>", F, "2026-10-20T09:00:00Z"),
      user("<command-name>/clear</command-name>", F, "2026-10-20T09:00:01Z"),
      user([{ type: "text", text: "meta stuff" }], F, "2026-10-20T09:00:02Z", { isMeta: true }),
      user([{ type: "text", text: "Add a status field to the orders API and show it in the order list page please" }], F, "2026-10-20T09:00:03Z"),
    ]);
    const byId = Object.fromEntries(claudeSessions(root, F).map((s) => [s.id, s.title]));
    expect(byId["s-custom"]).toBe("Mine");
    expect(byId["s-ai"]).toBe("Fix tax");
    expect(byId["s-prompt"]).toBe("Add a status field to the orders API and show it in the ord…");
  });

  test("a slash command with arguments is the title; one without is skipped", () => {
    const root = tmp("claude");
    transcript(root, F, "s-cmd", [
      user("<command-name>/clear</command-name>\n<command-message>clear</command-message>\n<command-args></command-args>", F, "2026-10-20T07:00:00Z"),
      user("<command-message>mr-review</command-message>\n<command-name>/mr-review</command-name>\n<command-args>https://x/mr/1</command-args>", F, "2026-10-20T07:00:01Z"),
    ]);
    expect(claudeSessions(root, F)[0].title).toBe("/mr-review https://x/mr/1");
  });

  test("lastAt, branch and lastLine", () => {
    const root = tmp("claude");
    transcript(root, F, "s1", [
      user("go", F, "2026-10-20T07:00:00Z", { gitBranch: "dev" }),
      assistant("Done.\nTests pass, ready for review?", F, "2026-10-20T09:00:00Z", { gitBranch: "feature/x" }),
      { type: "file-history-snapshot", timestamp: "2026-10-21T00:00:00Z" },
    ]);
    const [s] = claudeSessions(root, F);
    expect(s).toEqual({
      id: "s1",
      title: "go",
      lastAt: "2026-10-20T09:00:00.000Z",
      branch: "feature/x",
      lastLine: "Tests pass, ready for review?",
    });
  });

  test("newest first", () => {
    const root = tmp("claude");
    transcript(root, F, "old", [user("a", F, "2026-10-01T00:00:00Z")]);
    transcript(root, F, "new", [user("b", F, "2026-10-05T00:00:00Z")]);
    transcript(root, F, "mid", [user("c", F, "2026-10-03T00:00:00Z")]);
    expect(claudeSessions(root, F).map((s) => s.id)).toEqual(["new", "mid", "old"]);
  });

  test("a session belongs to its first cwd", () => {
    const root = tmp("claude");
    transcript(root, F, "moved", [user("a", F, "2026-10-01T00:00:00Z"), user("b", `${F}/apps/ui`, "2026-10-01T01:00:00Z")]);
    transcript(root, F, "sub", [user("a", `${F}/apps/ui`, "2026-10-01T00:00:00Z")]);
    expect(claudeSessions(root, F).map((s) => s.id)).toEqual(["moved"]);
  });

  test("a colliding dir name doesn't mix projects", () => {
    const root = tmp("claude");
    expect(claudeDirName("/r/a.b")).toBe(claudeDirName("/r/a-b"));
    transcript(root, "/r/a.b", "dot", [user("x", "/r/a.b", "2026-10-01T00:00:00Z")]);
    transcript(root, "/r/a-b", "dash", [user("y", "/r/a-b", "2026-10-02T00:00:00Z")]);
    expect(claudeSessions(root, "/r/a.b").map((s) => s.id)).toEqual(["dot"]);
    expect(claudeSessions(root, "/r/a-b").map((s) => s.id)).toEqual(["dash"]);
  });

  test("skips empty transcripts and corrupt lines", () => {
    const root = tmp("claude");
    transcript(root, F, "empty", [{ type: "file-history-snapshot" }, { type: "mode" }]);
    transcript(root, F, "ok", [user("hi", F, "2026-10-01T00:00:00Z")], ["{not json", '{"type":"user","cwd":']);
    expect(claudeSessions(root, F).map((s) => s.id)).toEqual(["ok"]);
  });

  test("subagent transcripts are not sessions", () => {
    const root = tmp("claude");
    transcript(root, F, "main", [user("hi", F, "2026-10-01T00:00:00Z")]);
    const sub = path.join(root, claudeDirName(F), "main", "subagents");
    fs.mkdirSync(sub, { recursive: true });
    fs.writeFileSync(path.join(sub, "agent-1.jsonl"), JSON.stringify(user("sub", F, "2026-10-09T00:00:00Z")) + "\n");
    expect(claudeSessions(root, F).map((s) => s.id)).toEqual(["main"]);
  });

  test("missing dir: no sessions", () => {
    expect(claudeSessions(tmp("claude"), "/r/none")).toEqual([]);
  });
});

describe("claudeFolderStats", () => {
  test("counts transcripts and takes the newest mtime", () => {
    const root = tmp("claude");
    const a = transcript(root, "/r/shop", "a", [user("a", "/r/shop", "2026-10-01T00:00:00Z")]);
    const b = transcript(root, "/r/shop", "b", [user("b", "/r/shop", "2026-10-01T00:00:00Z")]);
    fs.utimesSync(a, new Date("2026-10-01T00:00:00Z"), new Date("2026-10-01T00:00:00Z"));
    fs.utimesSync(b, new Date("2026-10-03T00:00:00Z"), new Date("2026-10-03T00:00:00Z"));
    expect(claudeFolderStats(root, "/r/shop")).toEqual({ count: 2, lastUsed: new Date("2026-10-03T00:00:00Z") });
  });

  test("missing dir", () => {
    expect(claudeFolderStats(tmp("claude"), "/r/none")).toEqual({ count: 0, lastUsed: null });
  });
});


const hex = (s: string) => Buffer.from(s, "utf8").toString("hex");

/** Creates `<root>/<cursorDirName(folder)>/<id>/store.db` with meta row "0" (unless `meta` is null). */
function makeChat(root: string, folder: string, id: string, meta: object | null, mtime?: Date): string {
  const dir = path.join(root, cursorDirName(folder), id);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "store.db");
  const db = new Database(file);
  db.run("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT)");
  db.run("CREATE TABLE blobs (id TEXT PRIMARY KEY, data BLOB)");
  if (meta) db.run("INSERT INTO meta (key, value) VALUES (?, ?)", ["0", hex(JSON.stringify(meta))]);
  db.close();
  if (mtime) fs.utimesSync(file, mtime, mtime);
  return file;
}

describe("cursorSessions", () => {
  const F = "/r/ocr";

  test("cursorDirName is the md5 of the folder path", () => {
    expect(cursorDirName("/home/azis/repos/aura-ui")).toBe("ad0cd2d926fb6dbc475a65ac3b9e4763");
  });

  test("named chats, newest first", () => {
    const root = tmp("cursor");
    makeChat(root, F, "c-old", { agentId: "c-old", name: "Bank Statement Extraction", createdAt: 1 }, new Date("2026-10-01T00:00:00Z"));
    makeChat(root, F, "c-new", { agentId: "c-new", name: "Invoice OCR", createdAt: 2 }, new Date("2026-10-04T00:00:00Z"));
    expect(cursorSessions(root, F)).toEqual([
      { id: "c-new", title: "Invoice OCR", lastAt: "2026-10-04T00:00:00.000Z" },
      { id: "c-old", title: "Bank Statement Extraction", lastAt: "2026-10-01T00:00:00.000Z" },
    ]);
  });

  test("skips subagent chats", () => {
    const root = tmp("cursor");
    makeChat(root, F, "parent", { agentId: "parent", name: "Main", createdAt: 1 });
    makeChat(root, F, "helper", { agentId: "helper", name: "New Agent", createdAt: 2, subagentInfo: { parentAgentId: "parent" } });
    expect(cursorSessions(root, F).map((s) => s.id)).toEqual(["parent"]);
  });

  test("skips unreadable stores", () => {
    const root = tmp("cursor");
    makeChat(root, F, "good", { agentId: "good", name: "Good", createdAt: 1 });
    makeChat(root, F, "no-meta", null);
    const bad = path.join(root, cursorDirName(F), "garbage");
    fs.mkdirSync(bad, { recursive: true });
    fs.writeFileSync(path.join(bad, "store.db"), "not a db");
    fs.mkdirSync(path.join(root, cursorDirName(F), "no-store"));
    expect(cursorSessions(root, F).map((s) => s.id)).toEqual(["good"]);
  });

  test("lastAt uses the newer of store.db and store.db-wal", () => {
    const root = tmp("cursor");
    const db = makeChat(root, F, "c1", { agentId: "c1", name: "C", createdAt: 1 }, new Date("2026-10-01T00:00:00Z"));
    fs.writeFileSync(`${db}-wal`, "not a real wal, but not empty");
    fs.utimesSync(`${db}-wal`, new Date("2026-10-06T00:00:00Z"), new Date("2026-10-06T00:00:00Z"));
    expect(cursorSessions(root, F)[0].lastAt).toBe("2026-10-06T00:00:00.000Z");
  });

  test("reading never writes next to the store (WAL-mode stores, like Cursor's)", () => {
    const root = tmp("cursor");
    const dir = path.join(root, cursorDirName(F), "wal");
    fs.mkdirSync(dir, { recursive: true });
    const store = path.join(dir, "store.db");
    const db = new Database(store);
    db.run("PRAGMA journal_mode=WAL");
    db.run("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT)");
    db.run("INSERT INTO meta (key, value) VALUES (?, ?)", ["0", hex(JSON.stringify({ agentId: "wal", name: "Walled", createdAt: 1 }))]);
    db.close();
    const when = new Date("2026-10-02T00:00:00Z");
    fs.utimesSync(store, when, when);
    const before = fs.readdirSync(dir).sort();
    expect(cursorSessions(root, F)).toEqual([{ id: "wal", title: "Walled", lastAt: when.toISOString() }]);
    expect(fs.readdirSync(dir).sort()).toEqual(before);
    expect(fs.statSync(store).mtime).toEqual(when);
  });

  test("an empty -wal doesn't count as use", () => {
    const root = tmp("cursor");
    const store = makeChat(root, F, "c1", { agentId: "c1", name: "C", createdAt: 1 }, new Date("2026-10-01T00:00:00Z"));
    fs.writeFileSync(`${store}-wal`, "");
    fs.utimesSync(`${store}-wal`, new Date("2026-10-09T00:00:00Z"), new Date("2026-10-09T00:00:00Z"));
    expect(cursorSessions(root, F)[0].lastAt).toBe("2026-10-01T00:00:00.000Z");
    expect(cursorFolderStats(root, F).lastUsed).toEqual(new Date("2026-10-01T00:00:00Z"));
  });

  test("missing dir: no sessions", () => {
    expect(cursorSessions(tmp("cursor"), "/r/none")).toEqual([]);
  });
});

describe("cursorFolderStats", () => {
  test("counts chats and takes the newest mtime", () => {
    const root = tmp("cursor");
    makeChat(root, "/r/ocr", "a", { agentId: "a", name: "A", createdAt: 1 }, new Date("2026-10-01T00:00:00Z"));
    makeChat(root, "/r/ocr", "b", { agentId: "b", name: "B", createdAt: 1 }, new Date("2026-10-02T00:00:00Z"));
    expect(cursorFolderStats(root, "/r/ocr")).toEqual({ count: 2, lastUsed: new Date("2026-10-02T00:00:00Z") });
    expect(cursorFolderStats(root, "/r/none")).toEqual({ count: 0, lastUsed: null });
  });
});

describe("listSessions", () => {
  test("marks sessions a live Herdr agent is running", async () => {
    const { deps } = testDeps({
      "agent list": () => ok({ agents: [{ name: "claude-2", agent: "claude", agent_status: "idle", cwd: "/x", pane_id: "w5:p3", tab_id: "w5:t3", workspace_id: "w5", agent_session: { value: "live" } }] }),
      "workspace list": () => ok({ workspaces: [ws("w5", "shop-api", 2)] }),
    });
    const p = deps.reg.projects[0];
    transcript(deps.claudeProjects, p.path, "live", [user("a", p.path, "2026-10-02T00:00:00Z")]);
    transcript(deps.claudeProjects, p.path, "idle", [user("b", p.path, "2026-10-01T00:00:00Z")]);
    const s = await listSessions(deps, p, deps.reg.agents[0], p.path);
    expect(s.map((x) => [x.id, x.openIn])).toEqual([
      ["live", { agentName: "claude-2", workspace: "shop-api", tabId: "w5:t3" }],
      ["idle", undefined],
    ]);
  });

  test("an agent kind with no session reader is refused", async () => {
    const { deps } = testDeps();
    const p = deps.reg.projects[0];
    const err = await listSessions(deps, p, { name: "aider", kind: "aider", openArgs: [], jobArgs: [] }, p.path).catch((e) => e);
    expect(err).toBeInstanceOf(OrchError);
    expect(err.message).toContain("can't list sessions for agent kind aider");
  });
});

/** Fake git listing `p.path` plus the given worktrees (real temp dirs). */
const worktreeGit = (base: string, wts: string[]): GitRunner => async () => ({
  code: 0,
  stdout: [base, ...wts].map((w, i) => `worktree ${w}\nHEAD 1111111\nbranch refs/heads/b${i}\n`).join("\n"),
  stderr: "",
});

function touchSession(root: string, folder: string, id: string, mtime: string) {
  const f = transcript(root, folder, id, [user("x", folder, mtime)]);
  fs.utimesSync(f, new Date(mtime), new Date(mtime));
}

describe("listFolderEntries", () => {
  test("base first, then most recently used, never-used last; withSessions drops empty worktrees", async () => {
    const [wtOld, wtNew, wtNone] = [tmp("wt-old"), tmp("wt-new"), tmp("wt-none")];
    const { deps } = testDeps();
    const p = deps.reg.projects[0];
    deps.git = worktreeGit(p.path, [wtNone, wtOld, wtNew]);
    touchSession(deps.claudeProjects, wtOld, "o1", "2026-10-01T00:00:00Z");
    touchSession(deps.claudeProjects, wtNew, "n1", "2026-10-03T00:00:00Z");
    touchSession(deps.claudeProjects, wtNew, "n2", "2026-10-04T00:00:00Z");
    const all = await listFolderEntries(deps, p, deps.reg.agents[0], { withSessions: false });
    expect(all.map((f) => [f.path, f.sessions, f.lastUsed])).toEqual([
      [p.path, 0, null],
      [wtNew, 2, "2026-10-04T00:00:00.000Z"],
      [wtOld, 1, "2026-10-01T00:00:00.000Z"],
      [wtNone, 0, null],
    ]);
    const used = await listFolderEntries(deps, p, deps.reg.agents[0], { withSessions: true });
    expect(used.map((f) => f.path)).toEqual([p.path, wtNew, wtOld]);
  });

  test("labels a job's worktree, live or not; a finished job's isn't labelled", async () => {
    const [wtA, wtB] = [tmp("wt-a"), tmp("wt-b")];
    const { deps } = testDeps({
      "agent list": () => ok({ agents: [{ name: "shop-api-a-1111", agent: "claude", agent_status: "idle", cwd: wtA, pane_id: "w1:p1", tab_id: "w1:t1", workspace_id: "w1" }] }),
    });
    const p = deps.reg.projects[0];
    deps.git = worktreeGit(p.path, [wtA, wtB]);
    const now = new Date(2026, 9, 23);
    const agentAt = (name: string, worktreePath: string) => ({
      project: "shop-api", agent: "claude", agentName: name, workspaceId: "w1", tabId: "w1:t1", paneId: "w1:p1",
      mode: "herdr-worktree" as const, worktreePath, status: "started",
    });
    const a = newJob(deps.root, deps.reg, { slug: "a", title: "A", request: "a", projects: ["shop-api"], now });
    upsertAgent(deps.root, a.id, agentAt("shop-api-a-1111", wtA));
    const b = newJob(deps.root, deps.reg, { slug: "b", title: "B", request: "b", projects: ["shop-api"], now });
    upsertAgent(deps.root, b.id, agentAt("shop-api-b-2222", wtB));
    const entries = await listFolderEntries(deps, p, deps.reg.agents[0], { withSessions: false });
    const job = (dir: string) => entries.find((f) => f.path === dir)?.job;
    expect(job(wtA)).toEqual({ id: a.id, live: true });
    expect(job(wtB)).toEqual({ id: b.id, live: false });
    setStage(deps.root, b.id, "done");
    const after = await listFolderEntries(deps, p, deps.reg.agents[0], { withSessions: false });
    expect(after.find((f) => f.path === wtB)?.job).toBeUndefined();
  });
});

describe("listProjects", () => {
  test("most recently used first, unused last, ties by name", () => {
    const { deps } = testDeps();
    deps.reg = testRegistry(["zeta", "alpha", "mid"]);
    const [zeta, , mid] = deps.reg.projects;
    touchSession(deps.claudeProjects, mid.path, "m", "2026-10-01T00:00:00Z");
    makeChat(deps.cursorChats, zeta.path, "z", { agentId: "z", name: "Z", createdAt: 1 }, new Date("2026-10-05T00:00:00Z"));
    expect(listProjects(deps).map((x) => [x.name, x.lastUsed])).toEqual([
      ["zeta", "2026-10-05T00:00:00.000Z"],
      ["mid", "2026-10-01T00:00:00.000Z"],
      ["alpha", null],
    ]);
  });
});
