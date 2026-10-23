#!/usr/bin/env bun
import path from "node:path";
import { parseArgs } from "node:util";
import { OrchError } from "./src/errors";
import { gitRunner, type GitRunner } from "./src/git";
import { Herdr } from "./src/herdr";
import { appendLog, listJobs, loadJob, newJob, patchAgent, setStage, type JobAgent, type Stage } from "./src/jobs";
import { openProject } from "./src/open";
import { addProject, loadRegistry, ORCH_ROOT, type Registry } from "./src/registry";
import { projectSkills, resolveSkill, scanSkills } from "./src/skills";
import { spawnJobAgent } from "./src/spawn";
import { buildStatus, formatStatus } from "./src/status";

export { gitRunner, type GitRunner } from "./src/git";

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
  status [--json]                every agent across workspaces, by project and job
  project add <path> --description D [--name N] [--context a,b,c]
                                 register a repo as a project
  skills [project] [--resolve <skill>] [--json]
                                 list orchestrator or repo skills; resolve which copy an agent uses
  job new <slug> --title T --request R --projects a,b
  job list | job show <id> | job stage <id> <stage> | job log <id> <text>
  job agent <id> <agentName> key=value...   (status, designPath, planPath, branch, worktreePath)
  job spawn <id> <project> [agent] [--repo-worktree] [--trust]`;

const PATCHABLE = ["status", "designPath", "planPath", "branch", "worktreePath"] as const;

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

  async status(args, deps) {
    const { values } = parseArgs({ args, options: { json: { type: "boolean" } } });
    const rows = buildStatus(await deps.herdr.listAgents(), deps.reg, listJobs(deps.root));
    deps.out(values.json ? JSON.stringify(rows, null, 2) : formatStatus(rows));
    return 0;
  },

  async project(args, deps) {
    const [sub, ...rest] = args;
    const usage = "usage: project add <path> --description D [--name N] [--context a,b,c]";
    if (sub !== "add") throw new OrchError(usage);
    const { positionals, values } = parseArgs({
      args: rest,
      allowPositionals: true,
      options: { name: { type: "string" }, description: { type: "string" }, context: { type: "string" } },
    });
    if (positionals.length > 1) throw new OrchError(usage);
    const need = (v: string | undefined, what: string) => {
      if (!v) throw new OrchError(`project add: missing ${what}`);
      return v;
    };
    const p = addProject(path.join(deps.root, "registry"), deps.reg, {
      path: need(positionals[0], "<path>"),
      name: values.name,
      description: need(values.description, "--description"),
      context: (values.context ?? "").split(",").map((c) => c.trim()).filter(Boolean),
    });
    deps.out(JSON.stringify(p, null, 2));
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

  async job(args, deps) {
    const [sub, ...rest] = args;
    const need = (v: string | undefined, what: string) => {
      if (!v) throw new OrchError(`job ${sub}: missing ${what}`);
      return v;
    };
    switch (sub) {
      case "new": {
        const { positionals, values } = parseArgs({
          args: rest,
          allowPositionals: true,
          options: { title: { type: "string" }, request: { type: "string" }, projects: { type: "string" } },
        });
        const job = newJob(deps.root, deps.reg, {
          slug: need(positionals[0], "<slug>"),
          title: need(values.title, "--title"),
          request: need(values.request, "--request"),
          projects: need(values.projects, "--projects").split(",").map((p) => p.trim()).filter(Boolean),
          now: deps.now(),
        });
        deps.out(job.id);
        return 0;
      }
      case "list": {
        const jobs = listJobs(deps.root);
        deps.out(jobs.map((j) => `${j.id}  ${j.stage}  ${j.projects.join(",")}  ${j.title}`).join("\n") || "(no jobs)");
        return 0;
      }
      case "show": {
        const job = loadJob(deps.root, need(rest[0], "<id>"));
        deps.out(JSON.stringify(job, null, 2));
        deps.out(`summary: ${deps.root}/jobs/${job.id}/summary.md`);
        return 0;
      }
      case "stage": {
        const job = setStage(deps.root, need(rest[0], "<id>"), need(rest[1], "<stage>") as Stage);
        deps.out(`${job.id} stage ${job.stage}`);
        return 0;
      }
      case "log": {
        appendLog(deps.root, need(rest[0], "<id>"), need(rest.slice(1).join(" ") || undefined, "<text>"), deps.now());
        return 0;
      }
      case "agent": {
        const [id, agentName, ...pairs] = rest;
        const patch: Partial<JobAgent> = {};
        for (const pair of pairs) {
          const eq = pair.indexOf("=");
          const key = eq > 0 ? pair.slice(0, eq) : pair;
          if (!(PATCHABLE as readonly string[]).includes(key)) {
            throw new OrchError(`job agent: cannot set "${key}". Settable: ${PATCHABLE.join(", ")}`);
          }
          (patch as Record<string, string>)[key] = pair.slice(eq + 1);
        }
        patchAgent(deps.root, need(id, "<id>"), need(agentName, "<agentName>"), patch);
        return 0;
      }
      case "spawn": {
        const { positionals, values } = parseArgs({
          args: rest,
          allowPositionals: true,
          options: { "repo-worktree": { type: "boolean" }, trust: { type: "boolean" } },
        });
        const [id, project, agent] = positionals;
        const a = await spawnJobAgent(deps, need(id, "<id>"), need(project, "<project>"), agent, {
          repoWorktree: values["repo-worktree"] ?? false,
          trust: values.trust ?? false,
        });
        deps.out(`spawned ${a.agentName} (${a.agent}, ${a.mode}) pane ${a.paneId}`);
        return 0;
      }
      default:
        throw new OrchError("usage: job new|list|show|stage|log|agent|spawn ...");
    }
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
