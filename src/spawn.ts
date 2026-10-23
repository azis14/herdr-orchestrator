import { OrchError } from "./errors";
import type { GitRunner } from "./git";
import type { Herdr } from "./herdr";
import { loadJob, upsertAgent, type JobAgent } from "./jobs";
import { openProject, toAgentName } from "./open";
import { getAgent, getProject, type Registry } from "./registry";

/** Fallback base for job worktrees in repos with no rule of their own. */
const BASE_REMOTE = "origin";
const BASE_BRANCH = "dev";

/**
 * Start one agent for a job in one project.
 * Default: a fresh herdr worktree off a just-fetched origin/dev.
 * repoWorktree: open in the main checkout; the agent makes its own worktree per the repo's rules.
 */
export async function spawnJobAgent(
  deps: { herdr: Herdr; reg: Registry; root: string; git: GitRunner },
  jobId: string,
  project: string,
  agent: string | undefined,
  o: { repoWorktree: boolean; trust: boolean },
): Promise<JobAgent> {
  const job = loadJob(deps.root, jobId);
  if (!job.projects.includes(project)) {
    throw new OrchError(`project ${project} is not part of job ${jobId} (projects: ${job.projects.join(", ")})`);
  }
  const p = getProject(deps.reg, project);
  const a = getAgent(deps.reg, agent, p);
  const agentName = toAgentName(`${p.name}-${jobId}`);
  const existing = job.agents.find((x) => x.agentName === agentName);
  if (existing && existing.status !== "stopped") {
    throw new OrchError(
      `job ${jobId} already has agent ${agentName} (status ${existing.status}); mark it status=stopped to respawn`,
    );
  }

  let record: JobAgent;
  if (o.repoWorktree) {
    const r = await openProject(deps.herdr, deps.reg, p.name, a.name, { args: a.jobArgs, name: agentName });
    record = {
      project: p.name,
      agent: a.name,
      agentName,
      workspaceId: r.workspaceId,
      tabId: r.tabId,
      paneId: r.paneId,
      mode: "repo-worktree",
      status: "started",
    };
  } else {
    const fetched = await deps.git(p.path, ["fetch", BASE_REMOTE, BASE_BRANCH]);
    if (fetched.code !== 0) {
      throw new OrchError(`git fetch ${BASE_REMOTE} ${BASE_BRANCH} failed in ${p.path}: ${fetched.stderr.trim()}`);
    }
    const branch = `feature/${jobId}`;
    const worktreePath = `${p.path}.worktrees/${jobId}`;
    const placement = await deps.herdr.createWorktree({
      cwd: p.path,
      branch,
      base: `${BASE_REMOTE}/${BASE_BRANCH}`,
      path: worktreePath,
      label: `${p.name}:${jobId}`,
      trust: o.trust,
    });
    try {
      await deps.herdr.startAgent(agentName, a.kind, placement.paneId, a.jobArgs);
    } catch (e) {
      throw new OrchError(
        `${(e as Error).message}\nleft open: workspace ${placement.workspaceId} pane ${placement.paneId}, ` +
          `worktree ${worktreePath} on ${branch}`,
      );
    }
    record = {
      project: p.name,
      agent: a.name,
      agentName,
      ...placement,
      mode: "herdr-worktree",
      worktreePath,
      branch,
      status: "started",
    };
  }
  upsertAgent(deps.root, jobId, record);
  return record;
}
