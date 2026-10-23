import fs from "node:fs";
import { OrchError } from "./errors";
import type { GitRunner } from "./git";
import type { Herdr, Placement } from "./herdr";
import { loadJob, upsertAgent, type JobAgent } from "./jobs";
import { openProject, toAgentName } from "./open";
import { getAgent, getProject, type Registry } from "./registry";

/** Fallback base for job worktrees in repos with no rule of their own. */
const BASE_REMOTE = "origin";
const BASE_BRANCH = "dev";

/** What `spawnJobAgent` returns: the saved record, plus how a cleaned-up agent came back (not persisted). */
export type SpawnResult = JobAgent & {
  /** The session the agent resumed. */
  resumedSession?: string;
  /** The agent reopened in its `lastCwd` but had no session to resume. */
  resumedFresh?: true;
};

/** Statuses after which `job spawn` may start the agent again. */
const RESTARTABLE = ["stopped", "start-failed"];

/**
 * A valid, job-unique herdr agent name: `<project>-<slug>` trimmed to fit, plus a hash of the
 * full job id so long slugs that share a prefix (or a `-2` dedupe suffix) never collide.
 */
export function jobAgentName(project: string, jobId: string): string {
  const hash = Bun.hash(jobId).toString(16).padStart(4, "0").slice(-4);
  return `${toAgentName(`${project}-${jobId.replace(/^\d{8}-/, "")}`, 27)}-${hash}`;
}

/**
 * Start one agent for a job in one project.
 * Default: a fresh herdr worktree off a just-fetched origin/dev.
 * repoWorktree: open in the main checkout; the agent makes its own worktree per the repo's rules.
 * Respawn (record stopped/start-failed): adopt the agent if it is live. Else, if `orch cleanup` recorded a
 * `lastCwd`, reopen there and resume `sessionId`; else reopen its recorded worktree.
 */
export async function spawnJobAgent(
  deps: { herdr: Herdr; reg: Registry; root: string; git: GitRunner },
  jobId: string,
  project: string,
  agent: string | undefined,
  o: { repoWorktree: boolean; trust: boolean },
): Promise<SpawnResult> {
  const job = loadJob(deps.root, jobId);
  if (!job.projects.includes(project)) {
    throw new OrchError(`project ${project} is not part of job ${jobId} (projects: ${job.projects.join(", ")})`);
  }
  const p = getProject(deps.reg, project);
  const a = getAgent(deps.reg, agent, p);
  const agentName = jobAgentName(p.name, jobId);
  const existing = job.agents.find((x) => x.agentName === agentName);
  if (existing && !RESTARTABLE.includes(existing.status)) {
    throw new OrchError(
      `job ${jobId} already has agent ${agentName} (status ${existing.status}); mark it status=stopped to respawn`,
    );
  }

  const live = (await deps.herdr.listAgents()).find((x) => x.name === agentName);
  if (live) {
    // e.g. the user answered a startup dialog after a failed start: the agent is ours, adopt it.
    if (existing?.status === "start-failed" && live.pane_id === existing.paneId) {
      return saveLive(existing);
    }
    throw new OrchError(`a live herdr agent is already named ${agentName} (pane ${live.pane_id}); nothing was created`);
  }

  function save(record: JobAgent): JobAgent {
    upsertAgent(deps.root, jobId, record);
    return record;
  }

  /** The agent is live again: the cleanup leftovers have done their job. */
  function saveLive(record: JobAgent): JobAgent {
    const { lastCwd: _cwd, sessionId: _session, ...rest } = record;
    return save({ ...rest, status: "started" });
  }

  async function start(record: JobAgent, args: string[]): Promise<JobAgent> {
    save({ ...record, status: "starting" });
    try {
      await deps.herdr.startAgent(agentName, a.kind, record.paneId, args);
    } catch (e) {
      save({ ...record, status: "start-failed" });
      const where = record.worktreePath ? `, worktree ${record.worktreePath} on ${record.branch ?? "?"}` : "";
      throw new OrchError(
        `${(e as Error).message}\nleft open: workspace ${record.workspaceId} tab ${record.tabId} pane ${record.paneId}` +
          `${record.createdWorkspace ? " (new workspace created by orch)" : ""}${where}\n` +
          `recorded as start-failed; once the agent is ready, run job spawn again to adopt it`,
      );
    }
    return saveLive(record);
  }

  const base = { ...existing, project: p.name, agent: a.name, agentName };
  const worktreeArgs = [...a.jobArgs, ...(a.worktreeArgs ?? [])];

  // Respawn where `orch cleanup` left the agent, resuming its conversation.
  if (existing?.lastCwd && fs.existsSync(existing.lastCwd)) {
    const cwd = existing.lastCwd;
    const resume =
      existing.sessionId && a.resumeArgs
        ? a.resumeArgs.map((x) => x.replaceAll("{session}", existing.sessionId!))
        : [];
    const note = resume.length ? { resumedSession: existing.sessionId! } : { resumedFresh: true as const };
    if (cwd === existing.worktreePath) {
      const placement = await deps.herdr.createWorkspace(cwd, `${p.name}:${jobId}`);
      const started = await start(
        { ...base, mode: existing.mode, ...placement, createdWorkspace: true, status: "starting" },
        [...worktreeArgs, ...resume],
      );
      return { ...started, ...note };
    }
    // Not the job's own worktree (e.g. the user's checkout): never worktree-only args.
    const r = await openProject(deps.herdr, deps.reg, p.name, a.name, {
      args: [...a.jobArgs, ...resume],
      name: agentName,
      topic: agentName,
      cwd,
    });
    const saved = saveLive({
      ...base,
      mode: existing.mode,
      workspaceId: r.workspaceId,
      tabId: r.tabId,
      paneId: r.paneId,
      createdWorkspace: r.createdWorkspace,
      status: "started",
    });
    return { ...saved, ...note };
  }

  // Respawn into a worktree the job already has.
  if (existing?.worktreePath && fs.existsSync(existing.worktreePath)) {
    const placement = await deps.herdr.createWorkspace(existing.worktreePath, `${p.name}:${jobId}`);
    return start({ ...base, mode: existing.mode, ...placement, createdWorkspace: true, status: "starting" }, worktreeArgs);
  }

  if (o.repoWorktree) {
    // The user's own checkout: never pass worktree-only args (Cursor --trust would persist trust for it).
    const r = await openProject(deps.herdr, deps.reg, p.name, a.name, { args: a.jobArgs, name: agentName, topic: agentName });
    return saveLive({
      ...base,
      mode: "repo-worktree",
      workspaceId: r.workspaceId,
      tabId: r.tabId,
      paneId: r.paneId,
      createdWorkspace: r.createdWorkspace,
      status: "started",
    });
  }

  const fetched = await deps.git(p.path, ["fetch", BASE_REMOTE, BASE_BRANCH]);
  if (fetched.code !== 0) {
    throw new OrchError(`git fetch ${BASE_REMOTE} ${BASE_BRANCH} failed in ${p.path}: ${fetched.stderr.trim()}`);
  }
  const branch = `feature/${jobId}`;
  const worktreePath = `${p.path}.worktrees/${jobId}`;
  const placement: Placement = await deps.herdr.createWorktree({
    cwd: p.path,
    branch,
    base: `${BASE_REMOTE}/${BASE_BRANCH}`,
    path: worktreePath,
    label: `${p.name}:${jobId}`,
    trust: o.trust,
  });
  return start(
    { ...base, mode: "herdr-worktree", ...placement, worktreePath, branch, createdWorkspace: true, status: "starting" },
    worktreeArgs,
  );
}
