import type { Deps } from "../orch";
import { lastActivity, type Activity } from "./activity";
import { OrchError } from "./errors";
import { HerdrError, type AgentInfo, type TabInfo } from "./herdr";
import { appendLog, listJobs, loadJob, patchAgent } from "./jobs";
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

/** `30m`, `3h`, `2d` to milliseconds. */
export function parseDuration(s: string): number {
  const m = /^(\d+)([mhd])$/.exec(s);
  if (!m) throw new OrchError(`bad --idle "${s}": use e.g. 30m, 3h, 2d`);
  return Number(m[1]) * { m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2] as "m" | "h" | "d"];
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
 * no child processes under the agent (if herdr can't say, that counts as a failure). Herdr is only asked about processes once the cheap checks pass.
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
  if (minIdleMs > 0 && idleMs !== null && idleMs < minIdleMs) {
    return { ok: false, reason: `active ${formatAge(idleMs)} ago` };
  }

  try {
    for (const pid of await d.herdr.processPids(a.pane_id, a.agent)) {
      if ((await d.children(pid)).length) return { ok: false, reason: "running child processes" };
    }
  } catch (e) {
    if (!(e instanceof HerdrError)) throw e;
    return { ok: false, reason: "process info unavailable" }; // can't prove it's idle, so leave it open
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

  // null: herdr couldn't list this workspace's tabs
  const tabs = new Map<string, TabInfo[] | null>();
  const tabsOf = async (workspaceId: string): Promise<TabInfo[] | null> => {
    if (!tabs.has(workspaceId)) {
      try {
        tabs.set(workspaceId, await d.herdr.listTabs(workspaceId));
      } catch (e) {
        if (!(e instanceof HerdrError)) throw e;
        tabs.set(workspaceId, null);
      }
    }
    return tabs.get(workspaceId)!;
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
    const workspaceTabs = await tabsOf(row.workspaceId);
    if (!workspaceTabs) {
      skipped.push({ agentName: row.agentName, paneId: row.paneId, workspace, reason: "tab info unavailable" });
      continue;
    }
    // A tab we can't find is assumed shared: closing just the pane is the least destructive answer.
    const tab = workspaceTabs.find((t) => t.tab_id === a.tab_id);
    const closes: Closes =
      !tab || tab.pane_count > 1 ? "pane" : byId.get(row.workspaceId)?.tab_count === 1 ? "tab+workspace" : "tab";
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

export const CLEANUP_NOTE =
  "note: scheduled wakeups, /loop and Monitor waits can't be detected; check before approving.";

/** The `orch cleanup` listing: a table with each agent's last message under it, then what was skipped, then a caveat. */
export function formatDormant(r: { candidates: Candidate[]; skipped: Skipped[] }): string {
  const lines: string[] = [];
  if (!r.candidates.length) lines.push("no dormant agents");
  else {
    const table = [
      ["AGENT", "WORKSPACE", "IDLE", "JOB", "CLOSES", "PICK"],
      ...r.candidates.map((c) => [
        c.agentName,
        c.workspace,
        c.idleMs === null ? "unknown" : formatAge(c.idleMs),
        c.jobId ?? "-",
        c.closes,
        c.pick,
      ]),
    ];
    const widths = table[0].map((_, i) => Math.max(...table.map((row) => row[i].length)));
    const row = (cells: string[]) => cells.map((c, i) => (i === cells.length - 1 ? c : c.padEnd(widths[i]))).join("  ");
    lines.push(row(table[0]));
    r.candidates.forEach((c, i) => {
      lines.push(row(table[i + 1]));
      if (c.lastMessage) lines.push(`  "${c.lastMessage}"`);
    });
  }
  if (r.skipped.length) {
    lines.push("skipped:");
    for (const s of r.skipped) lines.push(`  ${s.agentName} (${s.workspace}): ${s.reason}`);
  }
  lines.push(CLEANUP_NOTE);
  return lines.join("\n");
}

export interface Closed {
  agentName: string;
  paneId: string;
  workspace: string;
  closed: Closes;
  jobId?: string;
}

export interface Refused {
  pick: string;
  reason: string;
}

/**
 * Close the agents the user approved (`pick` strings from `findDormant`). Each is re-checked against live state first,
 * the same way `findDormant` checks it minus the idle threshold; one that fails is refused and the rest still go.
 * A job agent is recorded as stopped (with its session and folder) before its pane closes. A workspace is closed
 * once, after all its agents, and only if no tabs are left in it.
 */
export async function closeAgents(
  d: CleanupDeps,
  picks: string[],
): Promise<{ closed: Closed[]; refused: Refused[] }> {
  const closed: Closed[] = [];
  const refused: Refused[] = [];
  const agents = await d.herdr.listAgents();
  const labelOf = new Map((await d.herdr.listWorkspaces()).map((w) => [w.workspace_id, w.label]));
  const rows = buildStatus(agents, d.reg, listJobs(d.root));
  const done = new Set<string>();
  const tabClosed = new Map<string, Closed[]>(); // workspace id -> agents whose whole tab closed

  for (const pick of picks) {
    const at = pick.lastIndexOf("@");
    if (at < 1 || at === pick.length - 1) {
      refused.push({ pick, reason: "bad pick" });
      continue;
    }
    const paneId = pick.slice(0, at);
    const a = agents.find((x) => x.pane_id === paneId);
    const row = rows.find((r) => r.paneId === paneId);
    if (!a || !row || done.has(paneId)) {
      refused.push({ pick, reason: "gone" });
      continue;
    }
    const check = await checkAgent(d, a, row, 0);
    if (!check.ok) {
      refused.push({ pick, reason: check.reason });
      continue;
    }
    if (check.token !== pick) {
      refused.push({ pick, reason: "changed since listing" });
      continue;
    }

    // Fresh every time: an earlier pick may have closed a sibling pane in this tab.
    let tabs: TabInfo[];
    try {
      tabs = await d.herdr.listTabs(a.workspace_id);
    } catch (e) {
      if (!(e instanceof HerdrError)) throw e;
      refused.push({ pick, reason: "tab info unavailable" });
      continue;
    }
    // A tab we can't find is assumed shared: closing just the pane is the least destructive answer.
    const tab = tabs.find((t) => t.tab_id === a.tab_id);
    const wholeTab = !!tab && tab.pane_count <= 1;

    let undo: ((error: string) => void) | undefined;
    if (row.jobId) {
      const recs = loadJob(d.root, row.jobId).agents;
      // The name is the record's identity; a pane id can be reused by a later agent.
      const rec = recs.find((x) => x.agentName === row.agentName) ?? recs.find((x) => x.paneId === a.pane_id);
      if (rec) {
        const patch = { status: "stopped", lastCwd: a.cwd, ...(check.sessionId && { sessionId: check.sessionId }) };
        patchAgent(d.root, row.jobId, rec.agentName, patch);
        appendLog(
          d.root,
          row.jobId,
          `cleanup closed ${row.agentName} (session ${check.sessionId ?? "none"}, folder ${a.cwd})`,
          d.now(),
        );
        undo = (error) => {
          // Put back what was there (an undefined field is dropped when the job is saved).
          patchAgent(d.root, row.jobId!, rec.agentName, {
            status: rec.status,
            sessionId: rec.sessionId,
            lastCwd: rec.lastCwd,
          });
          appendLog(d.root, row.jobId!, `cleanup could not close ${row.agentName}: ${error}`, d.now());
        };
      }
    }
    try {
      if (wholeTab) await d.herdr.closeTab(a.tab_id);
      else await d.herdr.closePane(a.pane_id);
    } catch (e) {
      undo?.(e instanceof Error ? e.message : String(e));
      if (!(e instanceof HerdrError)) throw e;
      refused.push({ pick, reason: `close failed: ${e.message}` });
      continue;
    }
    done.add(paneId);
    const c: Closed = {
      agentName: row.agentName,
      paneId,
      workspace: labelOf.get(a.workspace_id) ?? a.workspace_id,
      closed: wholeTab ? "tab" : "pane",
    };
    if (row.jobId) c.jobId = row.jobId;
    closed.push(c);
    if (wholeTab) tabClosed.set(a.workspace_id, [...(tabClosed.get(a.workspace_id) ?? []), c]);
  }

  for (const [workspaceId, members] of tabClosed) {
    let gone: boolean;
    try {
      // Herdr removes a workspace itself when its last tab closes; only close one that is still listed.
      gone = !(await d.herdr.listWorkspaces()).some((w) => w.workspace_id === workspaceId);
      if (!gone && (await d.herdr.listTabs(workspaceId)).length === 0) {
        await d.herdr.closeWorkspace(workspaceId);
        gone = true;
      }
    } catch (e) {
      if (!(e instanceof HerdrError)) throw e;
      continue; // can't tell; leave the workspace alone
    }
    if (gone) for (const c of members) c.closed = "tab+workspace";
  }
  return { closed, refused };
}
