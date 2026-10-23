import fs from "node:fs";
import path from "node:path";

export interface Activity {
  at: Date;
  /** Last non-empty line of the agent's last text reply in the main transcript (where a closing question shows up). */
  lastMessage?: string;
}

interface Entry {
  type?: string;
  subtype?: string;
  timestamp?: string;
  message?: { content?: unknown };
}

function readEntries(file: string): Entry[] {
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const entries: Entry[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line);
      if (e && typeof e === "object") entries.push(e);
    } catch {
      // half-written or corrupt line: skip it
    }
  }
  return entries;
}

/** Entries that mean the agent did or was asked something; trailing bookkeeping lines don't count. */
function isCounted(e: Entry): boolean {
  return e.type === "user" || e.type === "assistant" || (e.type === "system" && e.subtype === "turn_duration");
}

function newest(entries: Entry[]): number | null {
  let max: number | null = null;
  for (const e of entries) {
    if (!isCounted(e) || typeof e.timestamp !== "string") continue;
    const t = Date.parse(e.timestamp);
    if (!Number.isNaN(t) && (max === null || t > max)) max = t;
  }
  return max;
}

function lastLine(text: string): string | undefined {
  return text
    .split("\n")
    .map((l) => l.trim())
    .findLast((l) => l);
}

function lastMessage(entries: Entry[]): string | undefined {
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (e.type !== "assistant" || !Array.isArray(e.message?.content)) continue;
    const blocks = e.message.content as { type?: string; text?: unknown }[];
    for (let j = blocks.length - 1; j >= 0; j--) {
      const b = blocks[j];
      if (b?.type !== "text" || typeof b.text !== "string") continue;
      const line = lastLine(b.text);
      if (line) return line;
    }
  }
  return undefined;
}

/**
 * When the Claude session `sessionId` last did something, from transcript entry timestamps (never file mtime),
 * across the main transcript and its subagent transcripts. null when no `<sessionId>.jsonl` exists in any
 * project dir under `projectsDir`, or it holds no timestamped entries.
 */
export function lastActivity(projectsDir: string, sessionId: string): Activity | null {
  let dirs: string[];
  try {
    dirs = fs.readdirSync(projectsDir);
  } catch {
    return null;
  }
  const dir = dirs.map((d) => path.join(projectsDir, d)).find((d) => fs.existsSync(path.join(d, `${sessionId}.jsonl`)));
  if (!dir) return null;

  const main = readEntries(path.join(dir, `${sessionId}.jsonl`));
  let max = newest(main);

  const subDir = path.join(dir, sessionId, "subagents");
  let subs: string[] = [];
  try {
    subs = fs.readdirSync(subDir).filter((f) => f.endsWith(".jsonl"));
  } catch {
    // no subagents
  }
  for (const f of subs) {
    const t = newest(readEntries(path.join(subDir, f)));
    if (t !== null && (max === null || t > max)) max = t;
  }

  if (max === null) return null;
  const activity: Activity = { at: new Date(max) };
  const msg = lastMessage(main);
  if (msg) activity.lastMessage = msg;
  return activity;
}
