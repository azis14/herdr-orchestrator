import { Database } from "bun:sqlite";
import fs from "node:fs";
import path from "node:path";
import type { Deps } from "../orch";
import { lastMessage, newest, readEntries, type Entry } from "./activity";
import { OrchError } from "./errors";
import { listFolders, type Folder } from "./folders";
import { openJobs } from "./jobs";
import type { AgentDef, Project } from "./registry";

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

/**
 * The first thing the user actually typed: not a caveat or meta entry. A slash command counts only with
 * arguments (`/mr-review <url>`), so `/clear` and the like are skipped.
 */
function firstPrompt(entries: ClaudeEntry[]): string | undefined {
  for (const e of entries) {
    if (e.type !== "user" || e.isMeta) continue;
    const text = promptText(e)?.trim();
    if (!text || /^(<local-command|Caveat:)/.test(text)) continue;
    if (/^<command-/.test(text)) {
      const name = /<command-name>([^<]*)<\/command-name>/.exec(text)?.[1].trim();
      const args = /<command-args>([\s\S]*?)<\/command-args>/.exec(text)?.[1].trim();
      if (name && args) return `${name} ${args}`;
      continue;
    }
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

// --- Cursor ---------------------------------------------------------------------------------------

/** Cursor's chat-dir name for a folder: the md5 hex of its path. */
export function cursorDirName(folder: string): string {
  return new Bun.CryptoHasher("md5").update(folder).digest("hex");
}

function cursorChatDirs(cursorChats: string, folder: string): string[] {
  const dir = path.join(cursorChats, cursorDirName(folder));
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => path.join(dir, d.name));
  } catch {
    return [];
  }
}

interface CursorMeta {
  name?: string;
  createdAt?: number;
  subagentInfo?: unknown;
}

/** The chat's meta row "0" (hex-encoded JSON), read-only. null if the store can't be opened or has none. */
function readCursorMeta(store: string): CursorMeta | null {
  if (!fs.existsSync(store)) return null;
  let db: Database | undefined;
  try {
    db = new Database(store, { readonly: true });
    const row = db.query("SELECT value FROM meta WHERE key = '0'").get() as { value?: string } | null;
    if (!row?.value) return null;
    const meta = JSON.parse(Buffer.from(row.value, "hex").toString("utf8"));
    return meta && typeof meta === "object" ? meta : null;
  } catch {
    return null; // locked, corrupt or not a database: skip this chat
  } finally {
    db?.close();
  }
}

/**
 * Cursor chats started in `folder`, newest first. Cursor's helper agents (meta `subagentInfo`) are not sessions.
 * The meta only has `createdAt`, so `lastAt` is the newest mtime of `store.db` and its `-wal`.
 */
export function cursorSessions(cursorChats: string, folder: string): Session[] {
  const sessions: Session[] = [];
  for (const dir of cursorChatDirs(cursorChats, folder)) {
    const store = path.join(dir, "store.db");
    const meta = readCursorMeta(store);
    if (!meta || meta.subagentInfo) continue;
    const at = newestMtime([store, `${store}-wal`]) ?? (meta.createdAt ? new Date(meta.createdAt) : null);
    if (!at) continue;
    sessions.push({ id: path.basename(dir), title: shorten(meta.name || "(untitled)"), lastAt: at.toISOString() });
  }
  return sessions.sort((a, b) => b.lastAt.localeCompare(a.lastAt));
}

/** Chat count and newest store mtime for `folder`. For ordering only: stores aren't opened. */
export function cursorFolderStats(cursorChats: string, folder: string): FolderStats {
  const dirs = cursorChatDirs(cursorChats, folder);
  return { count: dirs.length, lastUsed: newestMtime(dirs.flatMap((d) => [path.join(d, "store.db"), path.join(d, "store.db-wal")])) };
}

// --- Listings -------------------------------------------------------------------------------------

export type SessionDeps = Pick<Deps, "herdr" | "git" | "root" | "claudeProjects" | "cursorChats" | "reg">;

/** A folder with how much the agent has been used there, and the job that owns it, if any. */
export interface FolderEntry extends Folder {
  lastUsed: string | null;
  sessions: number;
  job?: { id: string; live: boolean };
}

const READERS: Record<string, { sessions: typeof claudeSessions; stats: typeof claudeFolderStats; root: (d: SessionDeps) => string }> = {
  claude: { sessions: claudeSessions, stats: claudeFolderStats, root: (d) => d.claudeProjects },
  cursor: { sessions: cursorSessions, stats: cursorFolderStats, root: (d) => d.cursorChats },
};

function reader(a: AgentDef) {
  const r = READERS[a.kind];
  if (!r) throw new OrchError(`can't list sessions for agent kind ${a.kind}`);
  return r;
}

/** The agent's sessions launched in `folder`, newest first, each marked with the live Herdr agent running it, if any. */
export async function listSessions(d: SessionDeps, p: Project, a: AgentDef, folder: string): Promise<Session[]> {
  const r = reader(a);
  const sessions = r.sessions(r.root(d), folder);
  const live = (await d.herdr.listAgents()).filter((x) => x.agent_session?.value);
  if (!live.length) return sessions;
  const labels = new Map((await d.herdr.listWorkspaces()).map((w) => [w.workspace_id, w.label]));
  for (const s of sessions) {
    const x = live.find((x) => x.agent_session!.value === s.id);
    if (x) s.openIn = { agentName: x.name ?? x.pane_id, workspace: labels.get(x.workspace_id) ?? x.workspace_id, tabId: x.tab_id };
  }
  return sessions;
}

/**
 * The project's folders with the agent's session count and last use in each: base first, then worktrees most
 * recently used first, never-used ones last by path. `withSessions` drops worktrees with no sessions (never the base).
 */
export async function listFolderEntries(
  d: SessionDeps,
  p: Project,
  a: AgentDef,
  o: { withSessions: boolean },
): Promise<FolderEntry[]> {
  const r = reader(a);
  const jobWorktrees = openJobs(d.root).flatMap((j) =>
    j.agents.filter((x) => x.worktreePath).map((x) => ({ id: j.id, agentName: x.agentName, path: path.resolve(x.worktreePath!) })),
  );
  const liveNames = jobWorktrees.length ? new Set((await d.herdr.listAgents()).map((x) => x.name)) : new Set<string>();

  const entries = (await listFolders(d.git, p)).map((f): FolderEntry => {
    const stats = r.stats(r.root(d), f.path);
    const e: FolderEntry = { ...f, lastUsed: stats.lastUsed?.toISOString() ?? null, sessions: stats.count };
    const job = jobWorktrees.find((j) => j.path === f.path);
    if (job) e.job = { id: job.id, live: liveNames.has(job.agentName) };
    return e;
  });
  const [base, ...worktrees] = entries;
  const kept = o.withSessions ? worktrees.filter((f) => f.sessions > 0) : worktrees;
  kept.sort(
    (x, y) =>
      Number(x.lastUsed === null) - Number(y.lastUsed === null) ||
      (y.lastUsed ?? "").localeCompare(x.lastUsed ?? "") ||
      x.path.localeCompare(y.path),
  );
  return [base, ...kept];
}

/** Registered projects, most recently used first (any registered agent, base folder), then by name. */
export function listProjects(d: SessionDeps): Array<{ name: string; path: string; description: string; lastUsed: string | null }> {
  const kinds = [...new Set(d.reg.agents.map((a) => a.kind))].filter((k) => READERS[k]);
  const rows = d.reg.projects.map((p) => {
    const times = kinds.map((k) => READERS[k].stats(READERS[k].root(d), p.path).lastUsed?.getTime() ?? 0);
    const t = Math.max(0, ...times);
    return { name: p.name, path: p.path, description: p.description, lastUsed: t ? new Date(t).toISOString() : null };
  });
  return rows.sort(
    (x, y) =>
      Number(x.lastUsed === null) - Number(y.lastUsed === null) ||
      (y.lastUsed ?? "").localeCompare(x.lastUsed ?? "") ||
      x.name.localeCompare(y.name),
  );
}
