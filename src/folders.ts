import fs from "node:fs";
import path from "node:path";
import { OrchError } from "./errors";
import type { GitRunner } from "./git";
import type { Project } from "./registry";

/** A folder an agent can work in: the project's checkout or one of its git worktrees. */
export interface Folder {
  path: string;
  /** Branch name, `detached @ <sha>`, or null when unknown. */
  branch: string | null;
  base: boolean;
}

/** The path with symlinks resolved, or just resolved if it doesn't exist. */
function real(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

/**
 * The project's base folder first, then its git worktrees in git's order, from `git worktree list --porcelain`.
 * Worktrees whose path is gone are dropped. The base folder alone if git fails (not a repo), or if the project
 * isn't the top of a checkout (a subfolder of a repo): the repo's other checkouts aren't the project's.
 * Paths are compared with symlinks resolved, so a symlinked project path isn't listed twice.
 */
export async function listFolders(git: GitRunner, p: Project): Promise<Folder[]> {
  const base: Folder = { path: p.path, branch: null, base: true };
  const r = await git(p.path, ["worktree", "list", "--porcelain"]);
  if (r.code !== 0) return [base];

  const realBase = real(p.path);
  let baseListed = false;
  const worktrees: Folder[] = [];
  for (const block of r.stdout.split(/\n\s*\n/)) {
    const lines = block.split("\n").map((l) => l.trim());
    const at = lines.find((l) => l.startsWith("worktree "));
    if (!at) continue;
    const dir = path.resolve(at.slice("worktree ".length));
    const ref = lines.find((l) => l.startsWith("branch "));
    const head = lines.find((l) => l.startsWith("HEAD "))?.slice("HEAD ".length) ?? "";
    const branch = ref
      ? ref.slice("branch ".length).replace(/^refs\/heads\//, "")
      : lines.includes("detached")
        ? `detached @ ${head.slice(0, 7)}`
        : null;
    if (real(dir) === realBase) {
      base.branch = branch;
      baseListed = true;
      continue;
    }
    if (fs.existsSync(dir)) worktrees.push({ path: dir, branch, base: false });
  }
  return baseListed ? [base, ...worktrees] : [{ ...base, branch: null }];
}

/** `folder` unset → the base folder (no git call). Else it must be the base folder or one of the project's worktrees. */
export async function resolveFolder(git: GitRunner, p: Project, folder?: string): Promise<Folder> {
  if (folder === undefined) return { path: p.path, branch: null, base: true };
  const wanted = real(folder);
  const folders = await listFolders(git, p);
  const found = folders.find((f) => real(f.path) === wanted);
  if (!found) {
    throw new OrchError(
      `${path.resolve(folder)} is not a folder of ${p.name}. Folders: ${folders.map((f) => f.path).join(", ")}`,
    );
  }
  return found;
}
