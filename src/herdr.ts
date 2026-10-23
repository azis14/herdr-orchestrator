import { OrchError } from "./errors";

export type Runner = (args: string[]) => Promise<{ code: number; stdout: string; stderr: string }>;

export const herdrRunner: Runner = async (args) => {
  const proc = Bun.spawn(["herdr", ...args], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, stdout, stderr };
};

export class HerdrError extends OrchError {
  code?: string;
  args: string[];
  constructor(message: string, args: string[], code?: string) {
    super(message);
    this.name = "HerdrError";
    this.args = args;
    this.code = code;
  }
}

export interface Workspace {
  workspace_id: string;
  label: string;
  number: number;
  focused: boolean;
  tab_count?: number;
}

export interface TabInfo {
  tab_id: string;
  workspace_id: string;
  label: string;
  pane_count: number;
}

export interface AgentInfo {
  name?: string;
  agent: string;
  agent_status: string;
  cwd: string;
  pane_id: string;
  tab_id: string;
  workspace_id: string;
  agent_session?: { value: string };
  state_change_seq?: number;
}

export interface Placement {
  workspaceId: string;
  tabId: string;
  paneId: string;
}

/** Parse a `workspace create`-shaped result (also used for `worktree create`). */
function workspacePlacement(r: any): Placement {
  return { workspaceId: r.workspace.workspace_id, tabId: r.tab.tab_id, paneId: r.root_pane.pane_id };
}

export class Herdr {
  constructor(private run: Runner = herdrRunner) {}

  /** Run a herdr subcommand and return its parsed `.result`. */
  async call(args: string[]): Promise<any> {
    const { code, stdout, stderr } = await this.run(args);
    if (code !== 0) {
      let message = stderr.trim() || stdout.trim() || `exit ${code}`;
      let errCode: string | undefined;
      try {
        const parsed = JSON.parse(stderr);
        if (parsed?.error) {
          errCode = parsed.error.code;
          message = [parsed.error.code, parsed.error.message].filter(Boolean).join(": ") || message;
        }
      } catch {
        // not JSON: keep the raw text
      }
      throw new HerdrError(`herdr ${args.slice(0, 2).join(" ")} failed: ${message}`, args, errCode);
    }
    try {
      return JSON.parse(stdout).result;
    } catch {
      throw new HerdrError(`herdr ${args.slice(0, 2).join(" ")} returned non-JSON output: ${stdout.trim()}`, args);
    }
  }

  async listWorkspaces(): Promise<Workspace[]> {
    return (await this.call(["workspace", "list"])).workspaces ?? [];
  }

  async createWorkspace(cwd: string, label: string): Promise<Placement> {
    return workspacePlacement(await this.call(["workspace", "create", "--cwd", cwd, "--label", label, "--no-focus"]));
  }

  /** Without a label, herdr numbers the tab itself. */
  async createTab(workspaceId: string, cwd: string, label?: string): Promise<Placement> {
    const args = ["tab", "create", "--workspace", workspaceId, "--cwd", cwd];
    if (label) args.push("--label", label);
    const r = await this.call([...args, "--no-focus"]);
    return { workspaceId, tabId: r.tab.tab_id, paneId: r.root_pane.pane_id };
  }

  async renameTab(tabId: string, label: string): Promise<void> {
    await this.call(["tab", "rename", tabId, label]);
  }

  async createWorktree(o: {
    cwd: string;
    branch: string;
    base: string;
    path: string;
    label: string;
    trust: boolean;
  }): Promise<Placement> {
    const args = ["worktree", "create", "--cwd", o.cwd, "--branch", o.branch, "--base", o.base, "--path", o.path];
    args.push("--label", o.label, "--no-focus");
    if (o.trust) args.push("--trust-repository");
    return workspacePlacement(await this.call(args));
  }

  async startAgent(name: string, kind: string, paneId: string, args: string[]): Promise<void> {
    const cmd = ["agent", "start", name, "--kind", kind, "--pane", paneId];
    if (args.length) cmd.push("--", ...args);
    await this.call(cmd);
  }

  async listAgents(): Promise<AgentInfo[]> {
    return (await this.call(["agent", "list"])).agents ?? [];
  }

  async listTabs(workspaceId: string): Promise<TabInfo[]> {
    return (await this.call(["tab", "list", "--workspace", workspaceId])).tabs ?? [];
  }

  /** Pids of a pane's foreground processes whose name is `name`. */
  async processPids(paneId: string, name: string): Promise<number[]> {
    const r = await this.call(["pane", "process-info", "--pane", paneId]);
    const procs: { pid: number; name: string }[] = r.process_info?.foreground_processes ?? [];
    return procs.filter((p) => p.name === name).map((p) => p.pid);
  }

  /** The pane's last `lines` lines. `agent read` prints plain text, not JSON, so this bypasses `call`. */
  async readAgent(paneId: string, lines: number): Promise<string> {
    const args = ["agent", "read", paneId, "--lines", String(lines)];
    const { code, stdout, stderr } = await this.run(args);
    if (code !== 0) {
      throw new HerdrError(`herdr agent read failed: ${stderr.trim() || stdout.trim() || `exit ${code}`}`, args);
    }
    return stdout;
  }
}
