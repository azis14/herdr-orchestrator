import fs from "node:fs";
import path from "node:path";
import { OrchError } from "./errors";
import { listFolders } from "./folders";
import { gitRemote, type GitResult, type GitRunner } from "./git";
import type { MrInfo } from "./mr";
import type { Project } from "./registry";

export interface FixWorktree {
  path: string;
  branch: string;
  created: boolean;
}

const ALWAYS_PROTECTED = ["main", "master", "dev"];

const real = (p: string): string => {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
};

const gitMessage = (r: { stdout: string; stderr: string }): string => (r.stderr.trim() || r.stdout.trim() || "no output");

/**
 * A worktree on the MR's source branch, up to date with origin, where fixes can be made without touching the
 * user's own checkout. Reuses a worktree that already has the branch; otherwise creates
 * `<projectPath>.worktrees/<kind>-<number>`. Refuses anything unsafe, including local commits origin doesn't have
 * (the fix agent pushes the branch); never stashes, resets or forces.
 */
export async function prepareFixWorktree(
  git: GitRunner,
  project: Project,
  mr: MrInfo,
  o: { protect?: string[] } = {},
): Promise<FixWorktree> {
  const label = `${mr.kind} ${mr.number}`;
  const b = mr.sourceBranch;
  if (mr.state !== "open") throw new OrchError(`${label} is ${mr.state}; only an open ${mr.kind} can be fixed.`);
  if (mr.fork) throw new OrchError(`${label} comes from a fork; its branch can't be fixed from here.`);
  if (!b || b.startsWith("-")) throw new OrchError(`${label} has no usable source branch ("${b}").`);
  const protectedBranches = new Set([mr.targetBranch, mr.defaultBranch, ...ALWAYS_PROTECTED, ...(o.protect ?? [])].filter(Boolean));
  if (protectedBranches.has(b)) throw new OrchError(`${label}'s source branch "${b}" is protected; it won't be fixed here.`);

  const fetched = await gitRemote(git, project.path, ["fetch", "origin", b], "origin");
  if (fetched.code !== 0) throw new OrchError(`git fetch origin ${b} failed: ${gitMessage(fetched)}`);

  const folders = await listFolders(git, project);
  const holder = folders.find((f) => f.branch === b);
  if (holder?.base) {
    throw new OrchError(
      `"${b}" is checked out in ${holder.path}, your own checkout of ${project.name}. Switch it to another branch first; it won't be touched from here.`,
    );
  }

  let dir: string;
  let created = false;
  if (holder) {
    dir = holder.path;
  } else {
    dir = `${project.path}.worktrees/${mr.kind}-${mr.number}`;
    if (fs.existsSync(dir)) {
      const there = folders.find((f) => !f.base && real(f.path) === real(dir));
      if (!there) throw new OrchError(`${dir} already exists and is not a worktree of ${project.name}; move it away or remove it.`);
      throw new OrchError(`${dir} is a worktree of ${project.name} on ${there.branch ?? "an unknown branch"}, not "${b}"; use or remove it.`);
    }
    const local = await git(project.path, ["rev-parse", "--verify", "--quiet", `refs/heads/${b}`]);
    const add =
      local.code === 0
        ? await git(project.path, ["worktree", "add", dir, b])
        : await git(project.path, ["worktree", "add", "--track", "-b", b, dir, `origin/${b}`]);
    if (add.code !== 0) throw new OrchError(`git worktree add failed: ${gitMessage(add)}`);
    created = true;
  }

  const status = await git(dir, ["status", "--porcelain"]);
  const made = created ? `created ${dir}; ` : "";
  if (status.code !== 0) throw new OrchError(`${made}git status in ${dir} failed: ${gitMessage(status)}`);
  if (status.stdout.trim() !== "") {
    throw new OrchError(`${made}${dir} has uncommitted changes; commit or discard them first. Nothing was stashed or reset.`);
  }
  let pull: GitResult;
  try {
    pull = await gitRemote(git, dir, ["pull", "--ff-only", "origin", b], "origin");
  } catch (e) {
    throw e instanceof OrchError ? new OrchError(`${made}${e.message}`) : e;
  }
  if (pull.code !== 0) throw new OrchError(`${made}git pull --ff-only origin ${b} failed in ${dir}: ${gitMessage(pull)}`);

  // Whatever the agent pushes from here goes on the MR: local commits nobody reviewed must not ride along.
  const aheadArgs = ["rev-list", "--count", `refs/remotes/origin/${b}..HEAD`];
  const aheadOut = await git(dir, aheadArgs);
  const ahead = Number(aheadOut.stdout.trim());
  if (aheadOut.code !== 0 || !aheadOut.stdout.trim() || !Number.isInteger(ahead)) {
    throw new OrchError(`${made}git ${aheadArgs.join(" ")} failed in ${dir}: ${gitMessage(aheadOut)}`);
  }
  if (ahead > 0) {
    throw new OrchError(`${made}${b} has local commits not on origin (${ahead} ahead); push or drop them yourself first — /mr-fix won't publish them`);
  }

  return { path: dir, branch: b, created };
}
