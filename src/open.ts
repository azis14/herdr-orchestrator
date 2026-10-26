import { OrchError } from "./errors";
import { resolveFolder, type Folder } from "./folders";
import type { AgentInfo, Herdr, Placement, Workspace } from "./herdr";
import { getAgent, getProject, type AgentDef, type Registry } from "./registry";
import { listSessions, type Session, type SessionDeps } from "./sessions";

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

/**
 * `base` if no live agent has it, else `${base}-${n}` for the smallest free n >= 2, kept a valid
 * herdr name. Herdr names are unique across the whole session, not per workspace.
 */
export function nextAgentName(base: string, live: AgentInfo[]): string {
  const taken = new Set(live.map((a) => a.name).filter(Boolean));
  const make = (n: number) =>
    n === 1 ? toAgentName(base) : `${toAgentName(base, AGENT_NAME_MAX - String(n).length - 1)}-${n}`;
  let n = 1;
  while (taken.has(make(n))) n++;
  return make(n);
}

export interface TerminalResult {
  project: string;
  workspaceId: string;
  tabId: string;
  paneId: string;
  createdWorkspace: boolean;
}

/** A new tab in the project's workspace, creating the workspace if needed; `topic` labels the tab. */
async function placeTab(h: Herdr, cwd: string, label: string, topic?: string) {
  const existing = findProjectWorkspace(await h.listWorkspaces(), label);
  const placement: Placement = existing
    ? await h.createTab(existing.workspace_id, cwd, topic)
    : await h.createWorkspace(cwd, label);
  return { placement, createdWorkspace: !existing };
}

/** Open a plain terminal on a project: a new tab in the project's workspace, with no agent started. */
export async function openTerminal(
  h: Herdr,
  reg: Registry,
  project: string,
  o: { topic?: string; cwd?: string } = {},
): Promise<TerminalResult> {
  const p = getProject(reg, project);
  const { placement, createdWorkspace } = await placeTab(h, o.cwd ?? p.path, p.name, o.topic);
  if (createdWorkspace && o.topic) {
    try {
      await h.renameTab(placement.tabId, o.topic);
    } catch (e) {
      throw new OrchError(
        `${(e as Error).message}\n` +
          `left open: workspace ${placement.workspaceId} tab ${placement.tabId} pane ${placement.paneId}`,
      );
    }
  }
  return { project: p.name, ...placement, createdWorkspace };
}

/**
 * Open an agent on a project: a new tab in the project's workspace, creating the workspace if needed.
 * `cwd` defaults to the project's path. The agent is named after its kind (`claude`, `claude-2`, ...). `topic` labels the tab; without it herdr's default stays.
 * `resume` is a session id: the agent starts with its `openArgs` plus its `resumeArgs` for that session.
 */
export async function openProject(
  h: Herdr,
  reg: Registry,
  project: string,
  agent?: string,
  o: { args?: string[]; name?: string; topic?: string; cwd?: string; resume?: string } = {},
): Promise<OpenResult> {
  const p = getProject(reg, project);
  const a = getAgent(reg, agent, p);
  const args = o.args ?? (o.resume === undefined ? a.openArgs : [...a.openArgs, ...resumeArgs(a, o.resume)]);
  const name = o.name ?? nextAgentName(a.name, await h.listAgents());
  const { placement, createdWorkspace } = await placeTab(h, o.cwd ?? p.path, p.name, o.topic);

  try {
    if (createdWorkspace && o.topic) await h.renameTab(placement.tabId, o.topic);
    await h.startAgent(name, a.kind, placement.paneId, args);
  } catch (e) {
    throw new OrchError(
      `${(e as Error).message}\n` +
        `left open: workspace ${placement.workspaceId} tab ${placement.tabId} pane ${placement.paneId} (agent ${name})`,
    );
  }
  return { project: p.name, agent: a.name, agentName: name, ...placement, createdWorkspace };
}

function requireResume(a: AgentDef): string[] {
  if (!a.resumeArgs?.length) throw new OrchError(`agent ${a.name} can't resume sessions (no resumeArgs)`);
  return a.resumeArgs;
}

/** The agent's `resumeArgs` for `session`. Refused when the agent has none. */
function resumeArgs(a: AgentDef, session: string): string[] {
  return requireResume(a).map((x) => x.replaceAll("{session}", session));
}

export interface AgentOpenResult extends OpenResult {
  folder: Folder;
  /** The session resumed, if any. */
  session?: Session;
}

/**
 * `open` as the CLI runs it: in `folder` (the base folder or one of the project's worktrees; default the base),
 * optionally resuming the newest session there (`continue`) or a given one (`resume`). Nothing is opened when the
 * folder or session is wrong.
 */
export async function openAgent(
  d: SessionDeps,
  project: string,
  agent: string | undefined,
  o: { topic?: string; folder?: string; continue?: boolean; resume?: string } = {},
): Promise<AgentOpenResult> {
  const p = getProject(d.reg, project);
  const a = getAgent(d.reg, agent, p);
  const folder = await resolveFolder(d.git, p, o.folder);
  let session: Session | undefined;
  if (o.continue || o.resume !== undefined) {
    requireResume(a);
    const sessions = await listSessions(d, p, a, folder.path);
    session = o.continue ? sessions[0] : sessions.find((s) => s.id === o.resume);
    if (!session) {
      throw new OrchError(
        o.continue ? `no ${a.name} sessions in ${folder.path}` : `no ${a.name} session ${o.resume} in ${folder.path}`,
      );
    }
  }
  const r = await openProject(d.herdr, d.reg, p.name, a.name, { topic: o.topic, cwd: folder.path, resume: session?.id });
  return { ...r, folder, ...(session && { session }) };
}
