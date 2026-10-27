#!/usr/bin/env bun
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { closeAgents, findDormant, formatAge, formatDormant, parseDuration } from "./src/cleanup";
import { vscodeRunner, type EditorRunner } from "./src/editor";
import { OrchError } from "./src/errors";
import { forgeRunner, type ForgeRunner } from "./src/forge";
import { resolveFolder } from "./src/folders";
import { gitRunner, type GitRunner } from "./src/git";
import { Herdr } from "./src/herdr";
import { appendLog, listJobs, loadJob, newJob, patchAgent, setStage, type JobAgent, type Stage } from "./src/jobs";
import { addAgent, removeAgent, removeProject, setDefaultAgent } from "./src/manage";
import { diffPosition, type Side } from "./src/diffpos";
import { listThreads, showMr } from "./src/mr";
import { prepareFixWorktree } from "./src/mrworktree";
import { checkBody, formatPost, OutsideError, parseReviewInput, postNote, postReview, replyThread, resolveThread } from "./src/mrpost";
import { openAgent, openTerminal } from "./src/open";
import { procChildren, type ChildrenRunner } from "./src/proc";
import { addProject, getAgent, getProject, loadRegistry, ORCH_ROOT, type Registry } from "./src/registry";
import { listFolderEntries, listProjects, listSessions } from "./src/sessions";
import { projectSkills, resolveSkill, scanSkills } from "./src/skills";
import { detect, formatDetection } from "./src/setup";
import { spawnJobAgent } from "./src/spawn";
import { buildStatus, formatStatus } from "./src/status";

export { gitRunner, type GitRunner } from "./src/git";

export interface Deps {
  herdr: Herdr;
  reg: Registry;
  /** Orchestrator root: where `jobs/` lives. */
  root: string;
  git: GitRunner;
  editor: EditorRunner;
  /** Claude's transcript root (`~/.claude/projects`). */
  claudeProjects: string;
  /** Cursor's chat root (`~/.cursor/chats`). */
  cursorChats: string;
  children: ChildrenRunner;
  /** Runs gh / glab. */
  forge: ForgeRunner;
  /** Everything piped to this process on stdin. */
  readStdin: () => Promise<string>;
  /** Where a binary is on PATH, or null. */
  which: (bin: string) => string | null;
  env: Record<string, string | undefined>;
  out: (s: string) => void;
  err: (s: string) => void;
  now: () => Date;
}

const USAGE = `usage: bun orch.ts <command>

  open <project> [agent] [--topic T] [--folder F] [--continue | --resume ID]
                                 open an agent in a new tab of the project's workspace (tab labelled T), in folder F
                                 (a worktree; default the base folder), resuming the newest session there or session ID
  bash <project> [--topic T] [--folder F]
                                 open a plain terminal, no agent, in a new tab of the project's workspace
  code <project | path | .>      open a project's repo, or any directory, in VS Code
  status [--json]                every agent across workspaces, by project and job
  cleanup [workspace...] [--idle D] [--json] | cleanup --close <pick...>
                                 list dormant agents (idle D, default 1h) with a pick for each; close approved picks
  folders <project> [agent] [--with-sessions] [--json]
                                 the project's base folder and git worktrees, with the agent's sessions in each
  sessions <project> [agent] [--folder F] [--json]
                                 the agent's sessions started in a folder (default: the base folder), newest first
  project list [--json]          registered projects, most recently used first
  project add <path> --description D [--name N] [--context a,b,c]
                                 register a repo as a project
  project remove <name>          unregister a project (refused while an unfinished job includes it)
  setup [--json]                 prerequisites, installed agents and registry state, for /setup
  agent add <claude|cursor> | agent default <name> | agent remove <name>
                                 register an agent, make it the default, or remove it
  skills [project] [--resolve <skill>] [--json]
                                 list orchestrator or repo skills; resolve which copy an agent uses
  job new <slug> --title T --request R --projects a,b
  job list | job show <id> | job stage <id> <stage> | job log <id> <text>
  job agent <id> <agentName> key=value...   (status, designPath, planPath, branch, worktreePath)
  job spawn <id> <project> [agent] [--repo-worktree] [--trust]
  mr show <ref> [--fetch] [--json]
  mr threads <ref> [--json]
  mr position <ref> --path P --line N [--old-path O] [--side new|old] [--json]
  mr post <ref> [--dry-run] [--json]
                                 post a review ({summary, comments} JSON on stdin); exits 3, posting nothing,
                                 if a comment is not on a changed line
  mr note <ref> [--json]         post a general note (body on stdin); prints its url
  mr reply <ref> --thread ID [--json]
                                 reply in a review thread (body on stdin); prints the reply's url
  mr resolve <ref> --thread ID [--json]
                                 resolve a review thread; prints "resolved: true", exits 1 if it stays unresolved
  mr worktree <ref> [--protect a,b] [--json]
                                 a worktree on the source branch to fix in (never your own checkout); prints its path
                                 review and fix a GitLab MR / GitHub PR; <ref> is its URL, or <project> <id> (id 42, !42 or #42)`;

const PATCHABLE = ["status", "designPath", "planPath", "branch", "worktreePath"] as const;

type Command = (args: string[], deps: Deps) => Promise<number>;

const commands: Record<string, Command> = {
  async open(args, deps) {
    const usage = "usage: open <project> [agent] [--topic T] [--folder F] [--continue | --resume ID]";
    const { positionals, values } = parseArgs({
      args,
      allowPositionals: true,
      options: {
        topic: { type: "string" },
        folder: { type: "string" },
        continue: { type: "boolean" },
        resume: { type: "string" },
      },
    });
    const [project, agent] = positionals;
    if (!project || positionals.length > 2) throw new OrchError(usage);
    const topic = values.topic?.trim();
    if (values.topic !== undefined && !topic) throw new OrchError("open: --topic is empty");
    if (values.continue && values.resume !== undefined) {
      throw new OrchError("open: --continue and --resume can't be used together");
    }
    const r = await openAgent(deps, project, agent, {
      topic,
      folder: values.folder,
      continue: values.continue,
      resume: values.resume,
    });
    const s = r.session;
    deps.out(
      `opened ${r.agentName} (${r.agent}) in ${r.project}: workspace ${r.workspaceId} tab ${r.tabId} pane ${r.paneId}` +
        (r.createdWorkspace ? " [new workspace]" : "") +
        (r.folder.base ? "" : ` — folder ${r.folder.path}`) +
        (s ? ` — resumed "${s.title}" (${s.id})` : "") +
        (s?.openIn ? ` (also open in ${s.openIn.workspace} tab ${s.openIn.tabId})` : ""),
    );
    return 0;
  },

  async bash(args, deps) {
    const usage = "usage: bash <project> [--topic T] [--folder F]";
    const { positionals, values } = parseArgs({
      args,
      allowPositionals: true,
      options: { topic: { type: "string" }, folder: { type: "string" } },
    });
    const [project] = positionals;
    if (!project || positionals.length > 1) throw new OrchError(usage);
    const topic = values.topic?.trim();
    if (values.topic !== undefined && !topic) throw new OrchError("bash: --topic is empty");
    const folder = await resolveFolder(deps.git, getProject(deps.reg, project), values.folder);
    const r = await openTerminal(deps.herdr, deps.reg, project, { topic, cwd: folder.path });
    deps.out(
      `opened terminal in ${r.project}: workspace ${r.workspaceId} tab ${r.tabId} pane ${r.paneId}` +
        (r.createdWorkspace ? " [new workspace]" : "") +
        (folder.base ? "" : ` — folder ${folder.path}`),
    );
    return 0;
  },

  async code(args, deps) {
    const { positionals } = parseArgs({ args, allowPositionals: true });
    if (positionals.length !== 1) throw new OrchError("usage: code <project | path | .>");
    const target = positionals[0];
    let name: string | undefined;
    let dir: string;
    if (deps.reg.projects.some((p) => p.name === target)) {
      ({ name, path: dir } = getProject(deps.reg, target));
    } else {
      dir = path.resolve(target);
      if (!fs.statSync(dir, { throwIfNoEntry: false })?.isDirectory()) {
        throw new OrchError(
          `"${target}" is neither a project nor a directory. Known projects: ${deps.reg.projects.map((p) => p.name).join(", ")}`,
        );
      }
    }
    const r = await deps.editor(dir);
    if (r.code !== 0) throw new OrchError(`code ${dir} failed (exit ${r.code})${r.stderr.trim() ? `: ${r.stderr.trim()}` : ""}`);
    deps.out(`opened ${name ? `${name} ` : ""}in VS Code: ${dir}`);
    return 0;
  },

  async status(args, deps) {
    const { values } = parseArgs({ args, options: { json: { type: "boolean" } } });
    const rows = buildStatus(await deps.herdr.listAgents(), deps.reg, listJobs(deps.root));
    deps.out(values.json ? JSON.stringify(rows, null, 2) : formatStatus(rows));
    return 0;
  },

  async cleanup(args, deps) {
    const usage = "usage: cleanup [workspace...] [--idle D] [--json] | cleanup --close <pick...>";
    const closeAt = args.indexOf("--close");
    if (closeAt >= 0) {
      // After --close come only picks; a workspace before it, or any flag after it, is a mixed-up call.
      const picks = args.slice(closeAt + 1);
      if (closeAt > 0 || !picks.length || picks.some((p) => p.startsWith("-"))) throw new OrchError(usage);
      const r = await closeAgents(deps, picks);
      for (const c of r.closed) {
        deps.out(`closed ${c.agentName} (${c.workspace}): ${c.closed}${c.jobId ? `, job ${c.jobId} stopped` : ""}`);
      }
      for (const f of r.refused) deps.out(`not closed ${f.pick}: ${f.reason}`);
      return r.closed.length || !r.refused.length ? 0 : 1;
    }
    const { positionals, values } = parseArgs({
      args,
      allowPositionals: true,
      options: { idle: { type: "string" }, json: { type: "boolean" } },
    });
    const idleMs = parseDuration(values.idle ?? "1h");
    const r = await findDormant(deps, { workspaces: positionals, idleMs });
    deps.out(values.json ? JSON.stringify(r, null, 2) : formatDormant(r));
    return 0;
  },

  async project(args, deps) {
    const [sub, ...rest] = args;
    const usage =
      "usage: project list [--json] | project add <path> --description D [--name N] [--context a,b,c] | project remove <name>";
    if (sub === "list") {
      const { values } = parseArgs({ args: rest, options: { json: { type: "boolean" } } });
      const rows = listProjects(deps);
      const ago = (iso: string | null) => (iso ? `${formatAge(deps.now().getTime() - Date.parse(iso))} ago` : "never");
      deps.out(values.json ? JSON.stringify(rows, null, 2) : rows.map((r) => `${r.name}  ${ago(r.lastUsed)}  ${r.description}`).join("\n"));
      return 0;
    }
    if (sub === "remove") {
      if (rest.length !== 1) throw new OrchError(usage);
      const p = removeProject(path.join(deps.root, "registry"), deps.root, rest[0]);
      deps.out(`removed project ${p.name} (${p.path})`);
      return 0;
    }
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

  async folders(args, deps) {
    const usage = "usage: folders <project> [agent] [--with-sessions] [--json]";
    const { positionals, values } = parseArgs({
      args,
      allowPositionals: true,
      options: { "with-sessions": { type: "boolean" }, json: { type: "boolean" } },
    });
    const [project, agent] = positionals;
    if (!project || positionals.length > 2) throw new OrchError(usage);
    const p = getProject(deps.reg, project);
    const rows = await listFolderEntries(deps, p, getAgent(deps.reg, agent, p), { withSessions: !!values["with-sessions"] });
    if (values.json) {
      deps.out(JSON.stringify(rows, null, 2));
      return 0;
    }
    const ago = (iso: string | null) => (iso ? `last ${formatAge(deps.now().getTime() - Date.parse(iso))} ago` : "never used");
    for (const f of rows) {
      const job = f.job ? `  job ${f.job.id}${f.job.live ? ", agent live" : ""}` : "";
      deps.out(`${f.base ? "base" : "worktree"}  ${f.path}  ${f.branch ?? "?"}  ${f.sessions} session${f.sessions === 1 ? "" : "s"}, ${ago(f.lastUsed)}${job}`);
    }
    return 0;
  },

  async sessions(args, deps) {
    const usage = "usage: sessions <project> [agent] [--folder F] [--json]";
    const { positionals, values } = parseArgs({
      args,
      allowPositionals: true,
      options: { folder: { type: "string" }, json: { type: "boolean" } },
    });
    const [project, agent] = positionals;
    if (!project || positionals.length > 2) throw new OrchError(usage);
    const p = getProject(deps.reg, project);
    const folder = await resolveFolder(deps.git, p, values.folder);
    const rows = await listSessions(deps, p, getAgent(deps.reg, agent, p), folder.path);
    if (values.json) {
      deps.out(JSON.stringify(rows, null, 2));
      return 0;
    }
    if (!rows.length) deps.out(`no sessions in ${folder.path}`);
    for (const s of rows) {
      const open = s.openIn ? `  [open in ${s.openIn.workspace} tab ${s.openIn.tabId}]` : "";
      const when = formatAge(deps.now().getTime() - Date.parse(s.lastAt));
      deps.out(`${s.id}  ${when} ago  ${s.branch ?? "-"}  ${s.title}${open}`);
    }
    return 0;
  },

  async setup(args, deps) {
    const { values } = parseArgs({ args, options: { json: { type: "boolean" } } });
    const d = detect(path.join(deps.root, "registry"), deps.which, deps.env);
    deps.out(values.json ? JSON.stringify(d, null, 2) : formatDetection(d));
    return 0;
  },

  async agent(args, deps) {
    const usage = "usage: agent add <claude|cursor> | agent default <name> | agent remove <name>";
    const [sub, name, ...extra] = args;
    if (!name || extra.length) throw new OrchError(usage);
    const dir = path.join(deps.root, "registry");
    if (sub === "add") deps.out(JSON.stringify(addAgent(dir, name)));
    else if (sub === "default") {
      setDefaultAgent(dir, name);
      deps.out(`default agent: ${name}`);
    } else if (sub === "remove") {
      removeAgent(dir, deps.root, name);
      deps.out(`removed agent ${name}`);
    } else throw new OrchError(usage);
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
        const how = a.resumedSession
          ? ` resumed session ${a.resumedSession}`
          : a.resumedFresh
            ? " (fresh: no session to resume)"
            : "";
        deps.out(`spawned ${a.agentName} (${a.agent}, ${a.mode}) pane ${a.paneId}${how}`);
        return 0;
      }
      default:
        throw new OrchError("usage: job new|list|show|stage|log|agent|spawn ...");
    }
  },

  async mr(args, deps) {
    const [sub, ...rest] = args;
    switch (sub) {
      case "show": {
        const { positionals, values } = parseArgs({
          args: rest,
          allowPositionals: true,
          options: { fetch: { type: "boolean" }, json: { type: "boolean" } },
        });
        const mr = await showMr(deps, positionals, { fetch: values.fetch });
        deps.out(values.json ? JSON.stringify(mr, null, 2) : `${mr.kind} ${mr.number} ${mr.state} ${mr.sourceBranch} → ${mr.targetBranch} ${mr.url}`);
        return 0;
      }
      case "threads": {
        const { positionals, values } = parseArgs({ args: rest, allowPositionals: true, options: { json: { type: "boolean" } } });
        const mr = await showMr(deps, positionals);
        const r = await listThreads(deps, mr);
        if (values.json) {
          deps.out(JSON.stringify(r, null, 2));
        } else {
          const open = r.threads.filter((t) => t.resolvable && !t.resolved).length;
          deps.out(`${mr.kind} ${mr.number}: ${r.threads.length} threads (${open} unresolved), ${r.notes.length} notes`);
        }
        return 0;
      }
      case "position": {
        const { positionals, values } = parseArgs({
          args: rest,
          allowPositionals: true,
          options: {
            path: { type: "string" },
            "old-path": { type: "string" },
            line: { type: "string" },
            side: { type: "string" },
            json: { type: "boolean" },
          },
        });
        if (!values.path) throw new OrchError("mr position needs --path <file at head>");
        const line = Number(values.line);
        if (!values.line || !Number.isInteger(line) || line < 1) throw new OrchError("mr position needs --line <positive integer>");
        const side = values.side ?? "new";
        if (side !== "new" && side !== "old") throw new OrchError(`--side must be new or old, got "${side}"`);
        const mr = await showMr(deps, positionals, { fetch: true });
        if (!mr.base) throw new OrchError(`no base commit for ${mr.kind} ${mr.number}`);
        const pos = await diffPosition(deps.git, mr.projectPath, mr.base, mr.head, {
          path: values.path,
          oldPath: values["old-path"],
          line,
          side: side as Side,
        });
        if (values.json) {
          deps.out(JSON.stringify(pos, null, 2));
        } else if (pos.kind === "outside") {
          deps.out(`outside: ${pos.path}:${line} (${side}) is not in any hunk`);
        } else {
          deps.out(`${pos.kind} ${pos.path}${pos.line !== undefined ? ` line ${pos.line}` : ""}${pos.oldLine !== undefined ? ` oldLine ${pos.oldLine}` : ""}`);
        }
        return pos.kind === "outside" ? 3 : 0;
      }
      case "post": {
        const { positionals, values } = parseArgs({
          args: rest,
          allowPositionals: true,
          options: { "dry-run": { type: "boolean" }, json: { type: "boolean" } },
        });
        const input = parseReviewInput(await deps.readStdin());
        const mr = await showMr(deps, positionals, { fetch: true });
        let r: Awaited<ReturnType<typeof postReview>>;
        try {
          r = await postReview(deps, mr, input, { dryRun: values["dry-run"] });
        } catch (e) {
          if (!(e instanceof OutsideError)) throw e;
          deps.out(JSON.stringify({ outside: e.outside }, null, 2));
          deps.err(`orch: ${e.message}`);
          return 3;
        }
        deps.out(values.json ? JSON.stringify(r, null, 2) : formatPost(r));
        return 0;
      }
      case "note":
      case "reply":
      case "resolve": {
        const { positionals, values } = parseArgs({
          args: rest,
          allowPositionals: true,
          options: { thread: { type: "string" }, json: { type: "boolean" } },
        });
        if (sub !== "note" && !values.thread) throw new OrchError(`mr ${sub} needs --thread ID (see \`mr threads\`)`);
        const body = sub === "resolve" ? "" : checkBody(await deps.readStdin());
        const mr = await showMr(deps, positionals);
        if (sub === "resolve") {
          const resolved = await resolveThread(deps, mr, values.thread!);
          if (!resolved) throw new OrchError(`thread ${values.thread} is still unresolved`);
          deps.out(values.json ? JSON.stringify({ resolved }) : `resolved: ${resolved}`);
        } else {
          const url = sub === "note" ? await postNote(deps, mr, body) : await replyThread(deps, mr, values.thread!, body);
          deps.out(values.json ? JSON.stringify({ url }) : url);
        }
        return 0;
      }
      case "worktree": {
        const { positionals, values } = parseArgs({
          args: rest,
          allowPositionals: true,
          options: { protect: { type: "string" }, json: { type: "boolean" } },
        });
        const mr = await showMr(deps, positionals);
        const protect = (values.protect ?? "").split(",").map((x) => x.trim()).filter(Boolean);
        const wt = await prepareFixWorktree(deps.git, getProject(deps.reg, mr.project), mr, { protect });
        deps.out(values.json ? JSON.stringify(wt, null, 2) : wt.path);
        return 0;
      }
      default:
        throw new OrchError("usage: mr show|threads|position|post|note|reply|resolve|worktree ...");
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
    let reg: Registry | undefined;
    return main(Bun.argv.slice(2), {
      herdr: new Herdr(),
      // Loaded on first use, so setup and agent commands work before a registry exists.
      get reg() {
        return (reg ??= loadRegistry());
      },
      root: ORCH_ROOT,
      git: gitRunner,
      editor: vscodeRunner,
      claudeProjects: path.join(os.homedir(), ".claude", "projects"),
      cursorChats: path.join(os.homedir(), ".cursor", "chats"),
      children: procChildren,
      forge: forgeRunner,
      readStdin: () => Bun.stdin.text(),
      which: (bin) => Bun.which(bin),
      env: process.env,
      out: (s) => console.log(s),
      err: (s) => console.error(s),
      now: () => new Date(),
    });
  };
  process.exit(await run());
}
