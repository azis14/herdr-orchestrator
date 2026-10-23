import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { lastActivity } from "../src/activity";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "orch-activity-"));

const user = (timestamp: string) => ({ type: "user", timestamp, message: { content: "hi" } });
const assistant = (timestamp: string, content: object[]) => ({ type: "assistant", timestamp, message: { content } });
const text = (t: string) => ({ type: "text", text: t });

/** Write `lines` (objects are JSON-encoded, strings kept raw) to `<dir>/<rel>`. */
function writeLines(dir: string, rel: string, lines: (object | string)[]) {
  const file = path.join(dir, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, lines.map((l) => (typeof l === "string" ? l : JSON.stringify(l))).join("\n") + "\n");
  return file;
}

describe("lastActivity", () => {
  test("uses the newest counted entry, not trailing bookkeeping lines", () => {
    const projects = tmp();
    const file = writeLines(projects, "-home-x-repo/s1.jsonl", [
      user("2026-10-22T10:00:00.000Z"),
      assistant("2026-10-22T10:05:00.000Z", [text("Done.\nmore")]),
      { type: "system", subtype: "turn_duration", timestamp: "2026-10-22T10:05:01.000Z" },
      { type: "system", subtype: "away_summary", timestamp: "2026-10-22T12:00:00.000Z" },
      { type: "permission-mode" },
      { type: "cost-state" },
    ]);
    const now = new Date();
    fs.utimesSync(file, now, now);
    const a = lastActivity(projects, "s1");
    expect(a?.at.toISOString()).toBe("2026-10-22T10:05:01.000Z");
    expect(a?.lastMessage).toBe("more");
  });

  test("lastMessage is the last non-empty line of the last assistant text block", () => {
    const projects = tmp();
    writeLines(projects, "-home-x-repo/s1.jsonl", [
      user("2026-10-22T10:00:00.000Z"),
      assistant("2026-10-22T10:01:00.000Z", [text("Older text")]),
      assistant("2026-10-22T10:02:00.000Z", [text("\n\n  Done.\nWorking on it\n\n")]),
      assistant("2026-10-22T10:03:00.000Z", [{ type: "thinking", thinking: "hmm" }, { type: "tool_use", name: "Bash" }]),
    ]);
    const a = lastActivity(projects, "s1");
    expect(a?.at.toISOString()).toBe("2026-10-22T10:03:00.000Z");
    expect(a?.lastMessage).toBe("Working on it");
  });

  test("lastMessage keeps a closing question after a longer reply", () => {
    const projects = tmp();
    writeLines(projects, "-home-x-repo/s1.jsonl", [
      assistant("2026-10-22T10:00:00.000Z", [text("Found two options.\n\nWhich do you want?\n")]),
    ]);
    expect(lastActivity(projects, "s1")?.lastMessage).toBe("Which do you want?");
  });

  test("includes subagent transcripts", () => {
    const projects = tmp();
    writeLines(projects, "-home-x-repo/s1.jsonl", [assistant("2026-10-22T10:00:00.000Z", [text("main said this")])]);
    writeLines(projects, "-home-x-repo/s1/subagents/agent-a.jsonl", [
      assistant("2026-10-22T11:30:00.000Z", [text("sub said that")]),
    ]);
    const a = lastActivity(projects, "s1");
    expect(a?.at.toISOString()).toBe("2026-10-22T11:30:00.000Z");
    expect(a?.lastMessage).toBe("main said this");
  });

  test("skips malformed lines", () => {
    const projects = tmp();
    writeLines(projects, "-home-x-repo/s1.jsonl", [
      user("2026-10-22T10:00:00.000Z"),
      assistant("2026-10-22T10:05:00.000Z", [text("Fine")]),
      '{"type":"assist',
    ]);
    const a = lastActivity(projects, "s1");
    expect(a?.at.toISOString()).toBe("2026-10-22T10:05:00.000Z");
    expect(a?.lastMessage).toBe("Fine");
  });

  test("finds the transcript in whichever project dir holds it", () => {
    const projects = tmp();
    writeLines(projects, "-home-x-other/s2.jsonl", [user("2026-10-22T09:00:00.000Z")]);
    writeLines(projects, "-home-x-repo/s1.jsonl", [user("2026-10-22T10:00:00.000Z")]);
    expect(lastActivity(projects, "s1")?.at.toISOString()).toBe("2026-10-22T10:00:00.000Z");
  });

  test("returns null when the transcript is missing", () => {
    const projects = tmp();
    writeLines(projects, "-home-x-repo/other.jsonl", [user("2026-10-22T10:00:00.000Z")]);
    expect(lastActivity(projects, "s1")).toBeNull();
    expect(lastActivity(path.join(projects, "nope"), "s1")).toBeNull();
  });
});
