import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { claudeDirName, claudeFolderStats, claudeSessions } from "../src/sessions";

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
