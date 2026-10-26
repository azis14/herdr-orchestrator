import fs from "node:fs";
import path from "node:path";
import { lastMessage, newest, readEntries, type Entry } from "./activity";

/** A past agent conversation that can be resumed. */
export interface Session {
  id: string;
  title: string;
  /** ISO time it last did something. */
  lastAt: string;
  branch?: string;
  lastLine?: string;
  /** Set when a live Herdr agent is running this session. */
  openIn?: { agentName: string; workspace: string; tabId: string };
}

/** Cheap per-folder numbers for ordering: how many sessions, and roughly when it was last used. */
export interface FolderStats {
  count: number;
  lastUsed: Date | null;
}

const TITLE_MAX = 60;

const shorten = (s: string, max = TITLE_MAX) => {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
};

function newestMtime(files: string[]): Date | null {
  let max: number | null = null;
  for (const f of files) {
    try {
      const t = fs.statSync(f).mtimeMs;
      if (max === null || t > max) max = t;
    } catch {
      // gone since listing
    }
  }
  return max === null ? null : new Date(max);
}

// --- Claude ---------------------------------------------------------------------------------------

type ClaudeEntry = Entry & {
  cwd?: string;
  gitBranch?: string;
  isMeta?: boolean;
  customTitle?: string;
  aiTitle?: string;
};

/** Claude's project-dir name for a folder: every non-alphanumeric char becomes "-". */
export function claudeDirName(folder: string): string {
  return folder.replace(/[^a-zA-Z0-9]/g, "-");
}

function claudeTranscripts(claudeProjects: string, folder: string): string[] {
  const dir = path.join(claudeProjects, claudeDirName(folder));
  try {
    return fs
      .readdirSync(dir)
      .filter((f) => f.endsWith(".jsonl"))
      .map((f) => path.join(dir, f));
  } catch {
    return [];
  }
}

/** Text of a user entry's prompt, or undefined for tool results and empty content. */
function promptText(e: ClaudeEntry): string | undefined {
  const c = e.message?.content;
  if (typeof c === "string") return c;
  if (!Array.isArray(c)) return undefined;
  const text = (c as { type?: string; text?: unknown }[]).find((b) => b?.type === "text" && typeof b.text === "string");
  return text?.text as string | undefined;
}

/** The first thing the user actually typed: not a slash-command wrapper, caveat or meta entry. */
function firstPrompt(entries: ClaudeEntry[]): string | undefined {
  for (const e of entries) {
    if (e.type !== "user" || e.isMeta) continue;
    const text = promptText(e)?.trim();
    if (!text || /^(<command-|<local-command|Caveat:)/.test(text)) continue;
    return text;
  }
  return undefined;
}

function claudeTitle(entries: ClaudeEntry[]): string {
  const custom = entries.findLast((e) => e.type === "custom-title" && e.customTitle)?.customTitle;
  const ai = entries.findLast((e) => e.type === "ai-title" && e.aiTitle)?.aiTitle;
  return shorten(custom ?? ai ?? firstPrompt(entries) ?? "(untitled)");
}

/**
 * Claude sessions launched in exactly `folder`, newest first. A session's folder is the `cwd` of its first entry
 * that has one; the dir name alone can't tell (`a.b` and `a-b` share one). Sessions with no activity are skipped.
 */
export function claudeSessions(claudeProjects: string, folder: string): Session[] {
  const sessions: Session[] = [];
  for (const file of claudeTranscripts(claudeProjects, folder)) {
    const entries = readEntries(file) as ClaudeEntry[];
    if (entries.find((e) => typeof e.cwd === "string")?.cwd !== folder) continue;
    const at = newest(entries);
    if (at === null) continue;
    const s: Session = { id: path.basename(file, ".jsonl"), title: claudeTitle(entries), lastAt: new Date(at).toISOString() };
    const branch = entries.findLast((e) => typeof e.gitBranch === "string" && e.gitBranch)?.gitBranch;
    if (branch) s.branch = branch;
    const line = lastMessage(entries);
    if (line) s.lastLine = line;
    sessions.push(s);
  }
  return sessions.sort((a, b) => b.lastAt.localeCompare(a.lastAt));
}

/** Transcript count and newest transcript mtime for `folder`. For ordering only: no parsing. */
export function claudeFolderStats(claudeProjects: string, folder: string): FolderStats {
  const files = claudeTranscripts(claudeProjects, folder);
  return { count: files.length, lastUsed: newestMtime(files) };
}
