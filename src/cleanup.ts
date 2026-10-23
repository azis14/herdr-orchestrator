import type { Deps } from "../orch";
import { lastActivity, type Activity } from "./activity";
import { OrchError } from "./errors";
import type { AgentInfo } from "./herdr";
import { listJobs } from "./jobs";
import { buildStatus, type StatusRow } from "./status";

export type CleanupDeps = Pick<Deps, "herdr" | "reg" | "root" | "claudeProjects" | "children" | "now">;
export type Closes = "pane" | "tab" | "tab+workspace";

export interface Candidate {
  agentName: string;
  kind: string;
  state: string;
  cwd: string;
  paneId: string;
  tabId: string;
  workspaceId: string;
  /** The workspace's label. */
  workspace: string;
  project: string | null;
  jobId?: string;
  sessionId?: string;
  /** null = unknown (no transcript, or nothing counted in it). */
  idleMs: number | null;
  lastMessage?: string;
  closes: Closes;
  /** Identifies this agent in this state; changes when the agent does anything, so a stale approval is refused. */
  pick: string;
}

export interface Skipped {
  agentName: string;
  paneId: string;
  workspace: string;
  reason: string;
}

const REVIEW_STAGES = ["design-review", "plan-review", "integrate"];

/** `45m`, `3h 5m`, `1d 2h`: the two largest units, a zero minor unit dropped. */
export function formatAge(ms: number): string {
  const mins = Math.max(0, Math.floor(ms / 60_000));
  const [d, h, m] = [Math.floor(mins / 1440), Math.floor((mins % 1440) / 60), mins % 60];
  const [major, minor] = d ? [`${d}d`, h && `${h}h`] : h ? [`${h}h`, m && `${m}m`] : [`${m}m`, 0];
  return minor ? `${major} ${minor}` : major;
}

export type AgentCheck =
  | { ok: true; activity: Activity | null; idleMs: number | null; sessionId?: string; token: string }
  | { ok: false; reason: string };

/** The `pick` token for an agent in its current state. */
export const pickToken = (paneId: string, seq: number | undefined, activity: Activity | null) =>
  `${paneId}@${seq ?? 0}-${activity?.at.getTime() ?? 0}`;

/**
 * Is this agent safe to close? Checks, in order: state is idle/done; its job isn't waiting on the user;
 * it has been inactive for at least `minIdleMs` (0 skips the threshold; unknown activity never fails it);
 * no child processes under the agent. Herdr is only asked about processes once the cheap checks pass.
 * `findDormant` and the close step both go through here, so they cannot disagree.
 */
export async function checkAgent(
  d: CleanupDeps,
  a: AgentInfo,
  row: StatusRow,
  minIdleMs: number,
): Promise<AgentCheck> {
  if (a.agent_status !== "idle" && a.agent_status !== "done") {
    return { ok: false, reason: `state ${a.agent_status}` };
  }
  if (row.jobId && row.stage && REVIEW_STAGES.includes(row.stage)) {
    return { ok: false, reason: `job ${row.jobId} waiting at ${row.stage}` };
  }

  const sessionId = a.agent_session?.value;
  const activity = sessionId ? lastActivity(d.claudeProjects, sessionId) : null;
  const idleMs = activity ? d.now().getTime() - activity.at.getTime() : null;
  if (idleMs !== null && idleMs < minIdleMs) return { ok: false, reason: `active ${formatAge(idleMs)} ago` };

  for (const pid of await d.herdr.processPids(a.pane_id, a.agent)) {
    if ((await d.children(pid)).length) return { ok: false, reason: "running child processes" };
  }
  return { ok: true, activity, idleMs, sessionId, token: pickToken(a.pane_id, a.state_change_seq, activity) };
}

async function paneLastLine(d: CleanupDeps, paneId: string): Promise<string | undefined> {
  try {
    const lines = (await d.herdr.readAgent(paneId, 20)).split("\n").map((l) => l.trim());
    return lines.filter((l) => l).pop();
  } catch {
    return undefined; // only a hint for the user; never worth failing the scan
  }
}

/** Idle agents in the chosen workspaces (all when `workspaces` is empty), and why the others were left alone. */
export async function findDormant(
  d: CleanupDeps,
  o: { workspaces: string[]; idleMs: number },
): Promise<{ candidates: Candidate[]; skipped: Skipped[] }> {
  const workspaces = await d.herdr.listWorkspaces();
  const labels = [...new Set(workspaces.map((w) => w.label))].sort();
  for (const l of o.workspaces) {
    if (!labels.includes(l)) throw new OrchError(`no workspace labelled "${l}". Known workspaces: ${labels.join(", ")}`);
  }
  const byId = new Map(workspaces.map((w) => [w.workspace_id, w]));
  const labelOf = (id: string) => byId.get(id)?.label ?? id;

  const agents = (await d.herdr.listAgents()).filter(
    (a) => !o.workspaces.length || o.workspaces.includes(labelOf(a.workspace_id)),
  );
  const rows = buildStatus(agents, d.reg, listJobs(d.root));
  const infoByPane = new Map(agents.map((a) => [a.pane_id, a]));

  const tabs = new Map<string, Awaited<ReturnType<typeof d.herdr.listTabs>>>();
  const paneCount = async (a: AgentInfo): Promise<number> => {
    if (!tabs.has(a.workspace_id)) tabs.set(a.workspace_id, await d.herdr.listTabs(a.workspace_id));
    return tabs.get(a.workspace_id)!.find((t) => t.tab_id === a.tab_id)?.pane_count ?? 1;
  };

  const candidates: Candidate[] = [];
  const skipped: Skipped[] = [];
  for (const row of rows) {
    const a = infoByPane.get(row.paneId)!;
    const workspace = labelOf(row.workspaceId);
    const check = await checkAgent(d, a, row, o.idleMs);
    if (!check.ok) {
      skipped.push({ agentName: row.agentName, paneId: row.paneId, workspace, reason: check.reason });
      continue;
    }
    const closes: Closes =
      (await paneCount(a)) > 1 ? "pane" : byId.get(row.workspaceId)?.tab_count === 1 ? "tab+workspace" : "tab";
    const c: Candidate = {
      agentName: row.agentName,
      kind: row.kind,
      state: row.state,
      cwd: row.cwd,
      paneId: row.paneId,
      tabId: row.tabId,
      workspaceId: row.workspaceId,
      workspace,
      project: row.project,
      idleMs: check.idleMs,
      closes,
      pick: check.token,
    };
    if (row.jobId) c.jobId = row.jobId;
    if (check.sessionId) c.sessionId = check.sessionId;
    const lastMessage = check.activity?.lastMessage ?? (await paneLastLine(d, row.paneId));
    if (lastMessage) c.lastMessage = lastMessage;
    candidates.push(c);
  }
  return { candidates, skipped };
}
