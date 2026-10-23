import fs from "node:fs";
import path from "node:path";
import { OrchError } from "./errors";
import { getProject, type Registry } from "./registry";

export const STAGES = ["design", "design-review", "plan", "plan-review", "build", "integrate", "done"] as const;
export type Stage = (typeof STAGES)[number];

export interface JobAgent {
  project: string;
  agent: string;
  agentName: string;
  workspaceId: string;
  tabId: string;
  paneId: string;
  mode: "herdr-worktree" | "repo-worktree";
  worktreePath?: string;
  branch?: string;
  designPath?: string;
  planPath?: string;
  /** True when the job created `workspaceId` (safe to close at cleanup); false means only `tabId` is the job's. */
  createdWorkspace?: boolean;
  status: string;
}

export interface Job {
  id: string;
  title: string;
  request: string;
  projects: string[];
  stage: Stage;
  createdAt: string;
  agents: JobAgent[];
}

const SLUG = /^[a-z0-9][a-z0-9-]{0,40}$/;

const SUMMARY_SECTIONS = [
  "Request",
  "Designs",
  "Cross-repo contract",
  "Questions answered across repos",
  "Questions answered by the user",
  "Open items",
  "Plans",
  "Build results",
];

const jobDir = (root: string, id: string) => path.join(root, "jobs", id);

function datePrefix(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
}

export function newJob(
  root: string,
  reg: Registry,
  o: { slug: string; title: string; request: string; projects: string[]; now: Date },
): Job {
  if (!SLUG.test(o.slug)) throw new OrchError(`bad job slug "${o.slug}": use lowercase letters, digits and dashes`);
  if (!o.projects.length) throw new OrchError("a job needs at least one project");
  for (const p of o.projects) getProject(reg, p);

  const baseId = `${datePrefix(o.now)}-${o.slug}`;
  let id = baseId;
  for (let n = 2; fs.existsSync(jobDir(root, id)); n++) id = `${baseId}-${n}`;

  const job: Job = {
    id,
    title: o.title,
    request: o.request,
    projects: o.projects,
    stage: "design",
    createdAt: o.now.toISOString(),
    agents: [],
  };
  fs.mkdirSync(jobDir(root, id), { recursive: true });
  saveJob(root, job);
  const sections = SUMMARY_SECTIONS.map((s) => `## ${s}\n\n${s === "Request" ? `${o.request}\n\n` : ""}`);
  fs.writeFileSync(path.join(jobDir(root, id), "summary.md"), `# ${o.title}\n\n${sections.join("")}`);
  fs.writeFileSync(path.join(jobDir(root, id), "log.md"), `# Log: ${o.title}\n\n`);
  return job;
}

export function loadJob(root: string, id: string): Job {
  const file = path.join(jobDir(root, id), "job.json");
  if (!fs.existsSync(file)) throw new OrchError(`unknown job "${id}"`);
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

export function saveJob(root: string, job: Job): void {
  fs.writeFileSync(path.join(jobDir(root, job.id), "job.json"), JSON.stringify(job, null, 2) + "\n");
}

/** All jobs, newest first. */
export function listJobs(root: string): Job[] {
  let ids: string[];
  try {
    ids = fs.readdirSync(path.join(root, "jobs"));
  } catch {
    return [];
  }
  return ids
    .filter((id) => fs.existsSync(path.join(jobDir(root, id), "job.json")))
    .map((id) => loadJob(root, id))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
}

export function setStage(root: string, id: string, stage: Stage): Job {
  if (!STAGES.includes(stage)) throw new OrchError(`unknown stage "${stage}". Stages: ${STAGES.join(", ")}`);
  const job = loadJob(root, id);
  job.stage = stage;
  saveJob(root, job);
  return job;
}

export function appendLog(root: string, id: string, text: string, now: Date): void {
  loadJob(root, id);
  fs.appendFileSync(path.join(jobDir(root, id), "log.md"), `## ${now.toISOString()}\n\n${text}\n\n`);
}

/** Insert or replace a job agent, keyed by agentName. */
export function upsertAgent(root: string, id: string, a: JobAgent): Job {
  const job = loadJob(root, id);
  const i = job.agents.findIndex((x) => x.agentName === a.agentName);
  if (i >= 0) job.agents[i] = a;
  else job.agents.push(a);
  saveJob(root, job);
  return job;
}

export function patchAgent(root: string, id: string, agentName: string, patch: Partial<JobAgent>): Job {
  const job = loadJob(root, id);
  const a = job.agents.find((x) => x.agentName === agentName);
  if (!a) throw new OrchError(`job ${id} has no agent "${agentName}"`);
  Object.assign(a, patch);
  saveJob(root, job);
  return job;
}
