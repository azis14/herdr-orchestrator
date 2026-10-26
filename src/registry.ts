import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { OrchError } from "./errors";

export const ORCH_ROOT = path.resolve(import.meta.dir, "..");

export interface Project {
  name: string;
  path: string;
  description: string;
  defaultAgent?: string;
  /** Context files and dirs, relative to `path`. */
  context: string[];
}

export interface AgentDef {
  name: string;
  /** Herdr `--kind`. */
  kind: string;
  /** Native args for interactive `orch open`. */
  openArgs: string[];
  /** Native args for job agents (broad permissions). */
  jobArgs: string[];
  /** Extra args only when the agent runs in a job-created worktree (e.g. Cursor `--trust`), never the user's checkout. */
  worktreeArgs?: string[];
  /** Args to resume a session; "{session}" is replaced by the id. */
  resumeArgs?: string[];
}

export interface Registry {
  projects: Project[];
  agents: AgentDef[];
  defaultAgent: string;
}

export function readJson(file: string): any {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    throw new OrchError(`cannot read registry file ${file}: ${(e as Error).message}`);
  }
}

export function loadRegistry(dir = path.join(ORCH_ROOT, "registry")): Registry {
  for (const f of ["agents.json", "projects.json"]) {
    if (!fs.existsSync(path.join(dir, f))) throw new OrchError(`no registry yet (missing registry/${f}): run /setup first`);
  }
  const projects: Project[] = readJson(path.join(dir, "projects.json")).projects ?? [];
  const agentsFile = readJson(path.join(dir, "agents.json"));
  const reg: Registry = { projects, agents: agentsFile.agents ?? [], defaultAgent: agentsFile.defaultAgent };

  const seen = new Set<string>();
  for (const p of reg.projects) {
    if (!p.name || !p.path) throw new OrchError(`project entry needs a name and a path: ${JSON.stringify(p)}`);
    if (seen.has(p.name)) throw new OrchError(`duplicate project name in registry: ${p.name}`);
    seen.add(p.name);
    p.path = path.resolve(p.path);
    p.context ??= [];
  }
  const agentNames = new Set(reg.agents.map((a) => a.name));
  if (!agentNames.has(reg.defaultAgent)) {
    throw new OrchError(`defaultAgent "${reg.defaultAgent}" is not a registered agent`);
  }
  for (const p of reg.projects) {
    if (p.defaultAgent && !agentNames.has(p.defaultAgent)) {
      throw new OrchError(`project ${p.name} has unknown defaultAgent "${p.defaultAgent}"`);
    }
  }
  return reg;
}

export function getProject(reg: Registry, name: string): Project {
  const p = reg.projects.find((x) => x.name === name);
  if (!p) {
    throw new OrchError(`unknown project "${name}". Known projects: ${reg.projects.map((x) => x.name).join(", ")}`);
  }
  if (!fs.existsSync(p.path)) {
    throw new OrchError(`project ${p.name} path does not exist: ${p.path}`);
  }
  return p;
}

export function getAgent(reg: Registry, name?: string, project?: Project): AgentDef {
  const wanted = name ?? project?.defaultAgent ?? reg.defaultAgent;
  const a = reg.agents.find((x) => x.name === wanted);
  if (!a) {
    throw new OrchError(`unknown agent "${wanted}". Known agents: ${reg.agents.map((x) => x.name).join(", ")}`);
  }
  return a;
}

/** The project a path belongs to: its checkout or a sibling `<path>.worktrees/` worktree. */
export function projectForPath(reg: Registry, p: string): Project | undefined {
  return reg.projects.find(
    (x) => p === x.path || p.startsWith(x.path + "/") || p.startsWith(x.path + ".worktrees/"),
  );
}

export interface NewProject {
  path: string;
  /** Defaults to the folder name. */
  name?: string;
  description: string;
  context: string[];
}

/** `projects.json` style: 2-space JSON with string arrays kept on one line. */
export function formatProjectsJson(data: unknown): string {
  return (
    JSON.stringify(data, null, 2).replace(
      /\[\n\s+("[^"\n]*",?\n\s+)*"[^"\n]*"\n\s+\]/g,
      (m) => "[" + [...m.matchAll(/"[^"\n]*"/g)].map((x) => x[0]).join(", ") + "]",
    ) + "\n"
  );
}

/** Validates a new project against the registry and appends it to `<dir>/projects.json`. Writes nothing on error. */
export function addProject(dir: string, reg: Registry, input: NewProject): Project {
  const raw = input.path === "~" || input.path.startsWith("~/") ? os.homedir() + input.path.slice(1) : input.path;
  const abs = path.resolve(raw);
  if (!fs.existsSync(abs)) throw new OrchError(`does not exist: ${abs}`);
  if (!fs.statSync(abs).isDirectory()) throw new OrchError(`not a directory: ${abs}`);

  const name = input.name ?? path.basename(abs);
  if (!/^[^\s,]+$/.test(name)) throw new OrchError(`invalid project name "${name}": no spaces or commas`);
  const owner = projectForPath(reg, abs);
  if (owner) throw new OrchError(`${abs} is already registered as ${owner.name}`);
  const inner = reg.projects.find((x) => x.path.startsWith(abs + "/") || abs === x.path + ".worktrees");
  if (inner) throw new OrchError(`${abs} contains registered project ${inner.name}`);
  if (reg.projects.some((p) => p.name === name)) throw new OrchError(`project "${name}" is already registered`);
  const description = input.description.trim();
  if (!description) throw new OrchError("a description is required");

  for (const c of input.context) {
    const rel = path.relative(abs, path.resolve(abs, c));
    if (path.isAbsolute(c) || rel === ".." || rel.startsWith("../")) {
      throw new OrchError(`context entry "${c}" must be a path inside ${abs}`);
    }
    if (!fs.existsSync(path.join(abs, c))) throw new OrchError(`context entry "${c}" not found in ${abs}`);
  }

  const project: Project = { name, path: abs, description, context: input.context };
  const file = path.join(dir, "projects.json");
  const data = readJson(file);
  data.projects = [...(data.projects ?? []), project];
  fs.writeFileSync(file, formatProjectsJson(data));
  return project;
}
