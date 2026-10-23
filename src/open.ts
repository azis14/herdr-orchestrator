import { OrchError } from "./errors";
import type { AgentInfo, Herdr, Placement, Workspace } from "./herdr";
import { getAgent, getProject, type Registry } from "./registry";

export interface OpenResult {
  project: string;
  agent: string;
  agentName: string;
  workspaceId: string;
  tabId: string;
  paneId: string;
  createdWorkspace: boolean;
}

/** The workspace labelled exactly `label`: the focused one if several match, else the lowest number. */
export function findProjectWorkspace(ws: Workspace[], label: string): Workspace | undefined {
  const matches = ws.filter((w) => w.label === label);
  return matches.find((w) => w.focused) ?? matches.sort((a, b) => a.number - b.number)[0];
}

/** Herdr agent names: a lowercase letter, then lowercase letters, digits, '-' or '_'; 32 chars max. */
const AGENT_NAME_MAX = 32;

function trimTo(name: string, max: number): string {
  return name.slice(0, max).replace(/[-_]+$/, "");
}

export function toAgentName(raw: string, max = AGENT_NAME_MAX): string {
  let name = raw.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/-{2,}/g, "-").replace(/^-+/, "");
  if (!/^[a-z]/.test(name)) name = `x-${name}`;
  return trimTo(name, max);
}

/** `${base}-${n}` for the smallest n >= 1 not already used by a live agent, kept a valid herdr name. */
export function nextAgentName(base: string, live: AgentInfo[]): string {
  const taken = new Set(live.map((a) => a.name).filter(Boolean));
  const make = (n: number) => `${toAgentName(base, AGENT_NAME_MAX - String(n).length - 1)}-${n}`;
  let n = 1;
  while (taken.has(make(n))) n++;
  return make(n);
}

/** Open an agent on a project: a new tab in the project's workspace, creating the workspace if needed. */
export async function openProject(
  h: Herdr,
  reg: Registry,
  project: string,
  agent?: string,
  o: { args?: string[]; name?: string } = {},
): Promise<OpenResult> {
  const p = getProject(reg, project);
  const a = getAgent(reg, agent, p);
  const name = o.name ?? nextAgentName(`${p.name}-${a.name}`, await h.listAgents());

  const existing = findProjectWorkspace(await h.listWorkspaces(), p.name);
  const placement: Placement = existing
    ? await h.createTab(existing.workspace_id, p.path, name)
    : await h.createWorkspace(p.path, p.name);

  try {
    await h.startAgent(name, a.kind, placement.paneId, o.args ?? a.openArgs);
  } catch (e) {
    throw new OrchError(
      `${(e as Error).message}\n` +
        `left open: workspace ${placement.workspaceId} tab ${placement.tabId} pane ${placement.paneId}`,
    );
  }
  return { project: p.name, agent: a.name, agentName: name, ...placement, createdWorkspace: !existing };
}
