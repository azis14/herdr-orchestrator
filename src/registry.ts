import fs from "node:fs";
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
}

export interface Registry {
  projects: Project[];
  agents: AgentDef[];
  defaultAgent: string;
}

function readJson(file: string): any {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    throw new OrchError(`cannot read registry file ${file}: ${(e as Error).message}`);
  }
}

export function loadRegistry(dir = path.join(ORCH_ROOT, "registry")): Registry {
  const projects: Project[] = readJson(path.join(dir, "projects.json")).projects ?? [];
  const agentsFile = readJson(path.join(dir, "agents.json"));
  const reg: Registry = { projects, agents: agentsFile.agents ?? [], defaultAgent: agentsFile.defaultAgent };

  const seen = new Set<string>();
  for (const p of reg.projects) {
    if (!p.name || !p.path) throw new OrchError(`project entry needs a name and a path: ${JSON.stringify(p)}`);
    if (seen.has(p.name)) throw new OrchError(`duplicate project name in registry: ${p.name}`);
    seen.add(p.name);
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
