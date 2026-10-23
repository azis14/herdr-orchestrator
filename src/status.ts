import type { AgentInfo } from "./herdr";
import type { Job, Stage } from "./jobs";
import { projectForPath, type Registry } from "./registry";

export interface StatusRow {
  agentName: string;
  project: string | null;
  kind: string;
  state: string;
  workspaceId: string;
  tabId: string;
  paneId: string;
  cwd: string;
  jobId?: string;
  stage?: Stage;
}

export function buildStatus(agents: AgentInfo[], reg: Registry, jobs: Job[]): StatusRow[] {
  const active = jobs.filter((j) => j.stage !== "done");
  const rows = agents.map((a): StatusRow => {
    const agentName = a.name ?? a.pane_id;
    const job = active.find((j) => j.agents.some((x) => x.paneId === a.pane_id || x.agentName === agentName));
    const row: StatusRow = {
      agentName,
      project: projectForPath(reg, a.cwd)?.name ?? null,
      kind: a.agent,
      state: a.agent_status,
      workspaceId: a.workspace_id,
      tabId: a.tab_id,
      paneId: a.pane_id,
      cwd: a.cwd,
    };
    if (job) Object.assign(row, { jobId: job.id, stage: job.stage });
    return row;
  });
  return rows.sort(
    (a, b) =>
      Number(a.project === null) - Number(b.project === null) ||
      (a.project ?? "").localeCompare(b.project ?? "") ||
      a.agentName.localeCompare(b.agentName),
  );
}

export function formatStatus(rows: StatusRow[]): string {
  const table = [
    ["AGENT", "PROJECT", "KIND", "STATE", "PANE", "JOB"],
    ...rows.map((r) => [
      r.agentName,
      r.project ?? "(unregistered)",
      r.kind,
      r.state,
      r.paneId,
      r.jobId ? `${r.jobId} (${r.stage})` : "-",
    ]),
  ];
  const widths = table[0].map((_, i) => Math.max(...table.map((row) => row[i].length)));
  return table.map((row) => row.map((c, i) => (i === row.length - 1 ? c : c.padEnd(widths[i]))).join("  ")).join("\n");
}
