#!/usr/bin/env bun
import { parseArgs } from "node:util";
import { OrchError } from "./src/errors";
import { Herdr } from "./src/herdr";
import { openProject } from "./src/open";
import { loadRegistry, ORCH_ROOT, type Registry } from "./src/registry";
import { projectSkills, resolveSkill, scanSkills } from "./src/skills";

export type GitRunner = (cwd: string, args: string[]) => Promise<{ code: number; stdout: string; stderr: string }>;

export const gitRunner: GitRunner = async (cwd, args) => {
  const proc = Bun.spawn(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, stdout, stderr };
};

export interface Deps {
  herdr: Herdr;
  reg: Registry;
  /** Orchestrator root: where `jobs/` lives. */
  root: string;
  git: GitRunner;
  out: (s: string) => void;
  err: (s: string) => void;
  now: () => Date;
}

const USAGE = `usage: bun orch.ts <command>

  open <project> [agent]         open an agent in a new tab of the project's workspace
  skills [project] [--resolve <skill>] [--json]
                                 list orchestrator or repo skills; resolve which copy an agent uses`;

type Command = (args: string[], deps: Deps) => Promise<number>;

const commands: Record<string, Command> = {
  async open(args, deps) {
    const { positionals } = parseArgs({ args, allowPositionals: true });
    const [project, agent] = positionals;
    if (!project) throw new OrchError("usage: open <project> [agent]");
    const r = await openProject(deps.herdr, deps.reg, project, agent);
    deps.out(
      `opened ${r.agentName} (${r.agent}) in ${r.project}: workspace ${r.workspaceId} tab ${r.tabId} pane ${r.paneId}` +
        (r.createdWorkspace ? " [new workspace]" : ""),
    );
    return 0;
  },

  async skills(args, deps) {
    const { positionals, values } = parseArgs({
      args,
      allowPositionals: true,
      options: { resolve: { type: "string" }, json: { type: "boolean" } },
    });
    const [project] = positionals;
    const print = (data: unknown, text: string) => deps.out(values.json ? JSON.stringify(data, null, 2) : text);
    if (!project) {
      if (values.resolve) throw new OrchError("--resolve needs a project");
      const own = scanSkills(deps.root);
      print(own, own.map((s) => s.name).join("\n"));
    } else if (values.resolve) {
      const r = resolveSkill(deps.reg, project, values.resolve, deps.root);
      print(r, `${r.source} ${r.path}`);
    } else {
      const ps = projectSkills(deps.reg, project, deps.root);
      const lines = ps.repoSkills.map((s) => s.name);
      if (!lines.length) lines.push("(no repo skills)");
      lines.push(`also in orchestrator: ${ps.alsoInOrchestrator.join(", ") || "-"}`);
      print(ps, lines.join("\n"));
    }
    return 0;
  },
};

export async function main(argv: string[], deps: Deps): Promise<number> {
  const [name, ...rest] = argv;
  const cmd = name ? commands[name] : undefined;
  if (!cmd) {
    deps.err(USAGE);
    return 2;
  }
  try {
    return await cmd(rest, deps);
  } catch (e) {
    const parseError = String((e as { code?: unknown })?.code ?? "").startsWith("ERR_PARSE_ARGS");
    if (e instanceof OrchError || parseError) {
      deps.err(`orch: ${(e as Error).message}`);
      return 1;
    }
    throw e;
  }
}

if (import.meta.main) {
  const run = async (): Promise<number> => {
    let reg: Registry;
    try {
      reg = loadRegistry();
    } catch (e) {
      console.error(`orch: ${(e as Error).message}`);
      return 1;
    }
    return main(Bun.argv.slice(2), {
      herdr: new Herdr(),
      reg,
      root: ORCH_ROOT,
      git: gitRunner,
      out: (s) => console.log(s),
      err: (s) => console.error(s),
      now: () => new Date(),
    });
  };
  process.exit(await run());
}
