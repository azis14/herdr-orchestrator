import fs from "node:fs";
import path from "node:path";
import type { Deps } from "../orch";
import { formatAge } from "./cleanup";
import { formatBytes } from "./disk";
import { OrchError } from "./errors";
import { listFolders, type Folder } from "./folders";
import { HerdrError, type HerdrWorktree, type PaneInfo } from "./herdr";
import { openJobs } from "./jobs";
import { getProject } from "./registry";
import { claudeFolderStats, cursorFolderStats } from "./sessions";

export type CleanWtDeps = Pick<Deps, "herdr" | "reg" | "root" | "git" | "claudeProjects" | "cursorChats" | "size" | "now">;

/** A repo's main checkout, and the registered project at it, if any. */
export interface Repo {
  name: string | null;
  path: string;
}

export interface WtCandidate {
  path: string;
  branch: string | null;
  /** null = no last-touched time could be read. */
  idleMs: number | null;
  /** What removing it would free; null when that couldn't be measured. */
  bytes: number | null;
  warnings: string[];
  /** `<pathId>@<stateHash>`: identifies this worktree in this state, and never contains the path. */
  pick: string;
}

export interface WtSkipped {
  path: string;
  branch: string | null;
  reason: string;
}

export interface WtRemoved {
  path: string;
  /** What removing it freed; null when that couldn't be measured. */
  bytes: number | null;
}

export interface WtRefused {
  pick: string;
  /** Set when the pick named a worktree that still exists. */
  path?: string;
  reason: string;
}

export interface WtListing {
  repo: Repo;
  idleMs: number;
  candidates: WtCandidate[];
  skipped: WtSkipped[];
  /** Worktrees touched within `idleMs`: not listed one by one. */
  recent: number;
  jobWarnings: string[];
  totalBytes: number;
}

/** The path with symlinks resolved, or just resolved if it doesn't exist. */
function real(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

const sha8 = (s: string) => new Bun.CryptoHasher("sha256").update(s).digest("hex").slice(0, 8);

/** The first half of a pick: identifies a worktree by its real path, without containing it. */
const pathId = (p: string) => sha8(real(p));

const gitError = (r: { code: number; stderr: string }) => r.stderr.trim() || `exit ${r.code}`;

/** The repo's folders: its main checkout (`base`) first, then its linked worktrees that still exist. */
async function repoFolders(d: CleanWtDeps, repo: Repo): Promise<Folder[]> {
  const project = { name: repo.name ?? path.basename(repo.path), path: repo.path, description: "", context: [] };
  return listFolders(d.git, project);
}

/** The main checkout of the (non-bare) repo `dir` is in. */
async function mainCheckout(d: CleanWtDeps, dir: string): Promise<string> {
  const r = await d.git(dir, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  if (r.code !== 0) throw new OrchError(`"${dir}" is not in a git repo`);
  const common = r.stdout.trim();
  if (path.basename(common) !== ".git") throw new OrchError("bare repositories aren't supported");
  return path.dirname(common);
}

/**
 * The repo a target names: a registered project, or a directory anywhere in a (non-bare) git repo. Either resolves
 * to that repo's main checkout (a project whose path is a linked worktree keeps its name). A registered project
 * name wins over a directory of the same name.
 */
export async function resolveRepo(d: CleanWtDeps, target: string): Promise<Repo> {
  if (d.reg.projects.some((p) => p.name === target)) {
    const p = getProject(d.reg, target);
    return { name: p.name, path: await mainCheckout(d, p.path) };
  }
  const dir = path.resolve(target);
  if (!fs.statSync(dir, { throwIfNoEntry: false })?.isDirectory()) {
    throw new OrchError(
      `"${target}" is neither a project nor a directory. Known projects: ${d.reg.projects.map((p) => p.name).join(", ")}`,
    );
  }
  const repo = await mainCheckout(d, dir);
  const realRepo = real(repo);
  return { name: d.reg.projects.find((p) => real(p.path) === realRepo)?.name ?? null, path: repo };
}

/** The entries of `git status --porcelain=v1 -z`, and every path they name (a rename or copy names its source too). */
function parseStatus(raw: string): { entries: number; paths: string[] } {
  const fields = raw.split("\0");
  const paths: string[] = [];
  let entries = 0;
  for (let i = 0; i < fields.length; i++) {
    const f = fields[i];
    if (!f) continue; // the trailing NUL
    entries++;
    paths.push(f.slice(3));
    if (/[RC]/.test(f.slice(0, 2)) && fields[i + 1]) paths.push(fields[++i]);
  }
  return { entries, paths };
}

/** A path's mtime, or null if it can't be read: gone (ENOENT), under a file now (ENOTDIR), unreadable (EACCES)... */
function mtimeMs(p: string, link = false): number | null {
  try {
    return (link ? fs.lstatSync : fs.statSync)(p).mtimeMs;
  } catch {
    return null;
  }
}

/**
 * A worktree's last-touched time (newest of its HEAD commit, its git dir's HEAD and index, its changed and untracked
 * files, and agent sessions there), the work removal would lose, and a hash of its state for the pick.
 * Throws an OrchError if `git status` (or the unpushed count) fails: nothing can be said about its work then.
 */
export async function inspectWorktree(
  d: CleanWtDeps,
  f: Folder,
): Promise<{ touchedMs: number | null; uncommitted: number; unpushed: number; head: string; stateHash: string }> {
  // Never let the listing touch the index: a rewritten index would make every worktree look fresh and every pick stale.
  const [status, log, head, gitDir, revList] = await Promise.all([
    d.git(f.path, ["--no-optional-locks", "status", "--porcelain=v1", "-z", "--untracked-files=all"]),
    d.git(f.path, ["log", "-1", "--format=%ct"]),
    d.git(f.path, ["rev-parse", "HEAD"]),
    d.git(f.path, ["rev-parse", "--absolute-git-dir"]),
    d.git(f.path, ["rev-list", "--count", "HEAD", "--not", "--remotes"]),
  ]);
  if (status.code !== 0) throw new OrchError(`git status failed: ${gitError(status)}`);
  if (revList.code !== 0) throw new OrchError(`git rev-list failed: ${gitError(revList)}`);
  const { entries, paths } = parseStatus(status.stdout);

  const times: (number | null)[] = [];
  const committed = Number(log.stdout.trim());
  if (log.code === 0 && log.stdout.trim() && Number.isFinite(committed)) times.push(committed * 1000);
  if (gitDir.code === 0) {
    const dir = gitDir.stdout.trim();
    times.push(mtimeMs(path.join(dir, "HEAD")), mtimeMs(path.join(dir, "index")));
  }
  for (const p of paths) times.push(mtimeMs(path.join(f.path, p), true));
  times.push(
    claudeFolderStats(d.claudeProjects, f.path).lastUsed?.getTime() ?? null,
    cursorFolderStats(d.cursorChats, f.path).lastUsed?.getTime() ?? null,
  );
  const touchedMs = times.reduce<number | null>((max, t) => (t !== null && (max === null || t > max) ? t : max), null);

  const headSha = head.code === 0 ? head.stdout.trim() : "";
  return {
    touchedMs,
    uncommitted: entries,
    unpushed: Number(revList.stdout.trim()) || 0,
    head: headSha,
    stateHash: sha8(`${headSha}\n${status.stdout}\n${touchedMs}`),
  };
}

/**
 * Why a worktree must not be removed, or null if nothing holds it: locked, an unfinished job's recorded folder in it,
 * another of `folders` inside it (`git worktree remove --force` would delete that one too), a Herdr pane in it, or a
 * Herdr workspace open in it. If Herdr can't be asked, every folder is held as `Herdr unavailable`.
 * "In it" compares real paths, so a pane in a subfolder holds the worktree. Pass every folder of the repo, main
 * checkout included, so a nested worktree is always seen.
 */
export async function blockedBy(
  d: CleanWtDeps,
  repo: Repo,
  folders: Folder[],
): Promise<(f: Folder) => string | null> {
  const realOf = new Map(folders.map((f) => [f.path, real(f.path)]));
  const jobPaths = openJobs(d.root).flatMap((j) =>
    j.agents.flatMap((a) =>
      [a.worktreePath, a.lastCwd].filter((p): p is string => !!p).map((p) => ({ id: j.id, path: real(p) })),
    ),
  );
  let herdr: { panes: PaneInfo[]; worktrees: HerdrWorktree[] } | null;
  try {
    const [panes, worktrees] = await Promise.all([d.herdr.listPanes(), d.herdr.listWorktrees(repo.path)]);
    herdr = { panes, worktrees };
  } catch (e) {
    if (!(e instanceof HerdrError)) throw e;
    herdr = null;
  }
  const paneCwds = (herdr?.panes ?? []).map((p) => ({
    id: p.pane_id,
    cwds: [p.cwd, p.foreground_cwd].filter((c): c is string => !!c).map(real),
  }));

  return (f) => {
    if (f.locked) return "locked";
    const wt = realOf.get(f.path) ?? real(f.path);
    const inside = (p: string) => p === wt || p.startsWith(wt + "/");
    const job = jobPaths.find((j) => inside(j.path));
    if (job) return `job ${job.id} unfinished`;
    const nested = folders.find((o) => realOf.get(o.path)!.startsWith(wt + "/"));
    if (nested) return `contains worktree ${path.relative(path.dirname(repo.path), nested.path)}`;
    if (!herdr) return "Herdr unavailable";
    const pane = paneCwds.find((p) => p.cwds.some(inside));
    if (pane) return `open in Herdr (pane ${pane.id})`;
    const open = herdr.worktrees.find((w) => w.open_workspace_id && inside(real(w.path)));
    if (open) return `open in Herdr (workspace ${open.open_workspace_id})`;
    return null;
  };
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/**
 * The repo's worktrees (never its main checkout) untouched for `idleMs` or more, with the work removing each would
 * lose and what it would free; those held back and why; how many were touched more recently; and unfinished jobs on
 * this project whose worktree isn't recorded. Herdr is asked only if some worktree is old enough.
 */
export async function findStale(d: CleanWtDeps, repo: Repo, o: { idleMs: number }): Promise<WtListing> {
  const folders = await repoFolders(d, repo);
  const worktrees = folders.filter((f) => !f.base);
  const now = d.now().getTime();

  type Seen =
    | { f: Folder; failed: string }
    | { f: Folder; failed?: undefined; info: Awaited<ReturnType<typeof inspectWorktree>>; idleMs: number | null };
  const seen = await Promise.all(
    worktrees.map(async (f): Promise<Seen> => {
      try {
        const info = await inspectWorktree(d, f);
        return { f, info, idleMs: info.touchedMs === null ? null : now - info.touchedMs };
      } catch (e) {
        if (!(e instanceof OrchError)) throw e;
        return { f, failed: e.message };
      }
    }),
  );
  const isRecent = (s: Seen) => s.failed === undefined && s.idleMs !== null && s.idleMs < o.idleMs;
  const old = seen.filter((s) => s.failed === undefined && !isRecent(s)).map((s) => s.f);
  const holds = old.length ? await blockedBy(d, repo, folders) : () => null;

  const candidates: Omit<WtCandidate, "bytes">[] = [];
  const skipped: WtSkipped[] = [];
  let recent = 0;
  for (const s of seen) {
    const { f } = s;
    if (s.failed !== undefined) {
      skipped.push({ path: f.path, branch: f.branch, reason: s.failed });
      continue;
    }
    if (isRecent(s)) {
      recent++;
      continue;
    }
    const reason = holds(f);
    if (reason) {
      skipped.push({ path: f.path, branch: f.branch, reason });
      continue;
    }
    const warnings: string[] = [];
    if (s.info.uncommitted) warnings.push(plural(s.info.uncommitted, "uncommitted file", "uncommitted files"));
    if (s.info.unpushed) warnings.push(plural(s.info.unpushed, "commit not pushed", "commits not pushed"));
    if (f.branch?.startsWith("detached @")) warnings.push("detached HEAD");
    if (s.idleMs === null) warnings.push("age unknown");
    candidates.push({
      path: f.path,
      branch: f.branch,
      idleMs: s.idleMs,
      warnings,
      pick: `${pathId(f.path)}@${s.info.stateHash}`,
    });
  }
  // Oldest first, unknown ages last (sort is stable, so ties keep git's order).
  candidates.sort((a, b) => (b.idleMs ?? -1) - (a.idleMs ?? -1));
  const sizes = await Promise.all(candidates.map((c) => d.size(c.path)));
  const sized = candidates.map((c, i): WtCandidate => ({ ...c, bytes: sizes[i] }));

  const jobWarnings = repo.name
    ? openJobs(d.root)
        .filter((j) => j.projects.includes(repo.name!))
        .filter((j) => j.agents.some((a) => a.project === repo.name && !a.worktreePath && !a.lastCwd))
        .map((j) => `warning: job ${j.id} is unfinished and its worktree isn't recorded; check before picking`)
    : [];

  return {
    repo,
    idleMs: o.idleMs,
    candidates: sized,
    skipped,
    recent,
    jobWarnings,
    totalBytes: sizes.reduce<number>((sum, b) => sum + (b ?? 0), 0),
  };
}

/**
 * Removes the picked worktrees (`git worktree remove --force`; branches stay), each only if it is still the worktree
 * the pick names, in the state it was listed in, with nothing holding it. Every other pick is refused with the reason.
 * Sizing comes first (it can take minutes); then what holds a worktree is checked once, against a fresh listing and
 * Herdr snapshot, and each worktree's state is checked right before it is removed, so no check is minutes old.
 * The idle threshold isn't checked again: any touch changes the state hash. Results are in pick order.
 */
export async function removeWorktrees(
  d: CleanWtDeps,
  repo: Repo,
  picks: string[],
): Promise<{ removed: WtRemoved[]; refused: WtRefused[]; freedBytes: number }> {
  const byId = (folders: Folder[]) => new Map(folders.filter((f) => !f.base).map((f) => [pathId(f.path), f]));
  const listed = byId(await repoFolders(d, repo));
  const handled = new Set<string>();
  type Entry =
    | { pick: string; refused: string }
    | { pick: string; refused?: undefined; id: string; state: string; f: Folder };
  const entries: Entry[] = picks.map((pick) => {
    const m = /^([0-9a-f]{8})@([0-9a-f]{8})$/.exec(pick);
    if (!m) return { pick, refused: "bad pick" };
    const [, id, state] = m;
    if (handled.has(id)) return { pick, refused: "duplicate pick" };
    handled.add(id);
    const f = listed.get(id);
    return f ? { pick, id, state, f } : { pick, refused: "gone" };
  });
  const resolved = entries.filter((e) => e.refused === undefined);
  const sizes = new Map(await Promise.all(resolved.map(async (e) => [e.id, await d.size(e.f.path)] as const)));

  // Fresh after sizing: a worktree nested, locked or opened meanwhile is seen.
  const folders = await repoFolders(d, repo);
  const current = byId(folders);
  const holds = resolved.length ? await blockedBy(d, repo, folders) : () => null;
  const removed: WtRemoved[] = [];
  const refused: WtRefused[] = [];
  for (const e of entries) {
    const { pick } = e;
    if (e.refused !== undefined) {
      refused.push({ pick, reason: e.refused });
      continue;
    }
    const f = current.get(e.id);
    if (!f) {
      refused.push({ pick, reason: "gone" });
      continue;
    }
    const held = holds(f);
    if (held) {
      refused.push({ pick, path: f.path, reason: held });
      continue;
    }
    let stateHash: string;
    try {
      ({ stateHash } = await inspectWorktree(d, f));
    } catch (err) {
      if (!(err instanceof OrchError)) throw err;
      refused.push({ pick, path: f.path, reason: err.message });
      continue;
    }
    if (stateHash !== e.state) {
      refused.push({ pick, path: f.path, reason: "changed since listing" });
      continue;
    }
    const r = await d.git(repo.path, ["worktree", "remove", "--force", f.path]);
    if (r.code !== 0) {
      refused.push({ pick, path: f.path, reason: `git worktree remove failed: ${gitError(r)}` });
      continue;
    }
    removed.push({ path: f.path, bytes: sizes.get(e.id) ?? null });
  }
  return { removed, refused, freedBytes: removed.reduce((sum, r) => sum + (r.bytes ?? 0), 0) };
}

/** The `orch clean-wt` listing: the table, the total, what was held back, the recent count, then job warnings. */
export function formatStale(l: WtListing): string {
  const rel = (p: string) => path.relative(path.dirname(l.repo.path), p);
  const lines: string[] = [];
  if (!l.candidates.length) lines.push(`no worktrees idle for ${formatAge(l.idleMs)} or more`);
  else {
    const table = [
      ["WORKTREE", "BRANCH", "IDLE", "FREES", "WARNINGS", "PICK"],
      ...l.candidates.map((c) => [
        rel(c.path),
        c.branch ?? "-",
        c.idleMs === null ? "unknown" : formatAge(c.idleMs),
        c.bytes === null ? "?" : formatBytes(c.bytes),
        c.warnings.length ? c.warnings.join(", ") : "-",
        c.pick,
      ]),
    ];
    const widths = table[0].map((_, i) => Math.max(...table.map((row) => row[i].length)));
    for (const cells of table) {
      lines.push(cells.map((c, i) => (i === cells.length - 1 ? c : c.padEnd(widths[i]))).join("  "));
    }
    lines.push(`about ${formatBytes(l.totalBytes)} would be freed (shared pnpm files stay in the pnpm store)`);
  }
  if (l.skipped.length) {
    lines.push("skipped:");
    for (const s of l.skipped) lines.push(`  ${rel(s.path)}: ${s.reason}`);
  }
  if (l.recent > 0) lines.push(`${l.recent} touched within ${formatAge(l.idleMs)}`);
  lines.push(...l.jobWarnings);
  return lines.join("\n");
}
