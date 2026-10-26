import fs from "node:fs";
import path from "node:path";
import { OrchError } from "./errors";
import { openJobs, type Job } from "./jobs";
import { formatProjectsJson, readJson, type AgentDef, type Project } from "./registry";

export interface AgentPreset {
  def: AgentDef;
  /** Executable `/setup` looks for on PATH. */
  bin: string;
  install: string;
}

export const AGENT_PRESETS: AgentPreset[] = [
  {
    def: { name: "claude", kind: "claude", openArgs: [], jobArgs: [], resumeArgs: ["--resume", "{session}"] },
    bin: "claude",
    install: "curl -fsSL https://claude.ai/install.sh | bash",
  },
  {
    def: {
      name: "cursor",
      kind: "cursor",
      openArgs: [],
      jobArgs: ["--force"],
      worktreeArgs: ["--trust"],
      resumeArgs: ["--resume", "{session}"],
    },
    bin: "cursor-agent",
    install: "curl https://cursor.com/install -fsS | bash",
  },
];

interface AgentsFile {
  defaultAgent: string;
  agents: AgentDef[];
}

const inline = (v: unknown): string =>
  Array.isArray(v)
    ? `[${v.map(inline).join(", ")}]`
    : v && typeof v === "object"
      ? `{ ${Object.entries(v).map(([k, x]) => `${JSON.stringify(k)}: ${inline(x)}`).join(", ")} }`
      : JSON.stringify(v);

/** `agents.json` style: 2-space JSON with one agent per line. */
export function formatAgentsJson(data: AgentsFile): string {
  const agents = data.agents.map((a) => `    ${inline(a)}`).join(",\n");
  return `{\n  "defaultAgent": ${JSON.stringify(data.defaultAgent)},\n  "agents": [\n${agents}\n  ]\n}\n`;
}

const agentsFile = (dir: string) => path.join(dir, "agents.json");
const projectsFile = (dir: string) => path.join(dir, "projects.json");

function readAgents(dir: string): AgentsFile {
  const data = readJson(agentsFile(dir));
  return { defaultAgent: data.defaultAgent, agents: data.agents ?? [] };
}

function readProjects(dir: string): Project[] {
  return fs.existsSync(projectsFile(dir)) ? (readJson(projectsFile(dir)).projects ?? []) : [];
}

/** Why `what` can't be removed while these jobs are unfinished, with how to close an abandoned one. */
function blockedByJobs(what: string, jobs: Job[]): OrchError {
  const lines = jobs.map((j) => `  ${j.id} (stage ${j.stage}): if abandoned, close it with: bun orch.ts job stage ${j.id} done`);
  return new OrchError(`${what} is used by unfinished jobs:\n${lines.join("\n")}`);
}

/** Registers a preset agent. Creates `agents.json` (with it as default) and an empty `projects.json` if missing. Writes nothing on error. */
export function addAgent(dir: string, name: string): AgentDef {
  const preset = AGENT_PRESETS.find((p) => p.def.name === name);
  if (!preset) {
    throw new OrchError(`unknown agent "${name}". Available: ${AGENT_PRESETS.map((p) => p.def.name).join(", ")}`);
  }
  const data: AgentsFile = fs.existsSync(agentsFile(dir)) ? readAgents(dir) : { defaultAgent: name, agents: [] };
  if (data.agents.some((a) => a.name === name)) throw new OrchError(`agent "${name}" is already registered`);
  data.agents.push(preset.def);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(agentsFile(dir), formatAgentsJson(data));
  if (!fs.existsSync(projectsFile(dir))) fs.writeFileSync(projectsFile(dir), formatProjectsJson({ projects: [] }));
  return preset.def;
}

export function setDefaultAgent(dir: string, name: string): void {
  const data = readAgents(dir);
  if (!data.agents.some((a) => a.name === name)) {
    throw new OrchError(`agent "${name}" is not registered. Registered: ${data.agents.map((a) => a.name).join(", ")}`);
  }
  data.defaultAgent = name;
  fs.writeFileSync(agentsFile(dir), formatAgentsJson(data));
}

/** Removes an agent unless it's the default, a project pins it, or an unfinished job uses it. Writes nothing on error. */
export function removeAgent(dir: string, root: string, name: string): void {
  const data = readAgents(dir);
  if (!data.agents.some((a) => a.name === name)) {
    throw new OrchError(`agent "${name}" is not registered. Registered: ${data.agents.map((a) => a.name).join(", ")}`);
  }
  if (data.defaultAgent === name) {
    throw new OrchError(`"${name}" is the default agent: make another agent the default first`);
  }
  const pinned = readProjects(dir).filter((p) => p.defaultAgent === name);
  if (pinned.length) {
    throw new OrchError(`"${name}" is the default agent of projects: ${pinned.map((p) => p.name).join(", ")}`);
  }
  const jobs = openJobs(root).filter((j) => j.agents.some((a) => a.agent === name));
  if (jobs.length) throw blockedByJobs(`agent "${name}"`, jobs);
  data.agents = data.agents.filter((a) => a.name !== name);
  fs.writeFileSync(agentsFile(dir), formatAgentsJson(data));
}

/** Removes a project's registry entry unless an unfinished job includes it. Never touches the repo, its worktrees or Herdr. */
export function removeProject(dir: string, root: string, name: string): Project {
  const data = readJson(projectsFile(dir));
  const projects: Project[] = data.projects ?? [];
  const project = projects.find((p) => p.name === name);
  if (!project) {
    throw new OrchError(`unknown project "${name}". Known projects: ${projects.map((p) => p.name).join(", ")}`);
  }
  const jobs = openJobs(root).filter((j) => j.projects.includes(name));
  if (jobs.length) throw blockedByJobs(`project "${name}"`, jobs);
  data.projects = projects.filter((p) => p.name !== name);
  fs.writeFileSync(projectsFile(dir), formatProjectsJson(data));
  return project;
}
