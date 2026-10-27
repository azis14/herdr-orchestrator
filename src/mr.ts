import type { Deps } from "../orch";
import { OrchError } from "./errors";
import { Forge, type Platform } from "./forge";
import { resolveRef } from "./mrref";

export interface MrInfo {
  platform: Platform;
  host: string;
  repo: string;
  project: string;
  projectPath: string;
  number: number;
  kind: "mr" | "pr";
  url: string;
  title: string;
  description: string;
  author: string;
  state: "open" | "merged" | "closed";
  draft: boolean;
  fork: boolean;
  sourceBranch: string;
  targetBranch: string;
  defaultBranch: string;
  head: string;
  base: string | null;
  start: string | null;
  me: string;
  /** GitHub PR node id (GraphQL); null on GitLab. */
  nodeId: string | null;
}

export type MrDeps = Pick<Deps, "reg" | "git" | "forge">;

/** "a/b" → "a%2Fb": a GitLab project path as one URL segment. */
export const encodeRepo = (repo: string): string => encodeURIComponent(repo);

export function forgeFor(deps: MrDeps, mr: { platform: Platform; host: string }): Forge {
  return new Forge(deps.forge, mr.platform, mr.host);
}

const GITLAB_STATES: Record<string, MrInfo["state"]> = { opened: "open", merged: "merged", closed: "closed", locked: "closed" };

/** The MR/PR behind `args` (a URL, or `<project> <id>`), normalized across GitLab and GitHub. */
export async function showMr(deps: MrDeps, args: string[], o: { fetch?: boolean } = {}): Promise<MrInfo> {
  const ref = await resolveRef(deps.reg, deps.git, args);
  const forge = forgeFor(deps, ref);
  const gitlab = ref.platform === "gitlab";
  const common = { platform: ref.platform, host: ref.host, repo: ref.repo, project: ref.project.name, projectPath: ref.project.path, number: ref.number };
  let info: MrInfo;
  let baseSha: string | undefined; // GitHub: the target branch tip the PR was opened against

  if (gitlab) {
    const enc = encodeRepo(ref.repo);
    const mr = await forge.rest("GET", `projects/${enc}/merge_requests/${ref.number}`);
    const proj = await forge.rest("GET", `projects/${enc}`);
    const user = await forge.rest("GET", "user");
    const refs = mr.diff_refs ?? {};
    info = {
      ...common,
      kind: "mr",
      url: mr.web_url,
      title: mr.title,
      description: mr.description ?? "",
      author: mr.author?.username ?? "",
      state: GITLAB_STATES[mr.state] ?? "closed",
      draft: !!(mr.draft ?? mr.work_in_progress),
      fork: mr.source_project_id !== mr.target_project_id,
      sourceBranch: mr.source_branch,
      targetBranch: mr.target_branch,
      defaultBranch: proj.default_branch,
      head: refs.head_sha ?? mr.sha,
      base: refs.base_sha ?? null,
      start: refs.start_sha ?? null,
      me: user.username,
      nodeId: null,
    };
  } else {
    const pr = await forge.rest("GET", `repos/${ref.repo}/pulls/${ref.number}`);
    const user = await forge.rest("GET", "user");
    const headRepo = pr.head?.repo?.full_name;
    info = {
      ...common,
      kind: "pr",
      url: pr.html_url,
      title: pr.title,
      description: pr.body ?? "",
      author: pr.user?.login ?? "",
      state: pr.merged ? "merged" : pr.state === "closed" ? "closed" : "open",
      draft: !!pr.draft,
      fork: !headRepo || headRepo !== pr.base.repo.full_name,
      sourceBranch: pr.head.ref,
      targetBranch: pr.base.ref,
      defaultBranch: pr.base.repo.default_branch,
      head: pr.head.sha,
      base: null,
      start: null,
      me: user.login,
      nodeId: pr.node_id ?? null,
    };
    baseSha = pr.base.sha;
  }

  if (o.fetch) {
    const headRef = gitlab ? `refs/merge-requests/${info.number}/head` : `refs/pull/${info.number}/head`;
    const fetchArgs = ["fetch", "origin", headRef, info.targetBranch];
    const f = await deps.git(info.projectPath, fetchArgs);
    if (f.code !== 0) throw new OrchError(`git ${fetchArgs.join(" ")} failed in ${info.projectPath}: ${f.stderr.trim()}`);
    const c = await deps.git(info.projectPath, ["cat-file", "-e", `${info.head}^{commit}`]);
    if (c.code !== 0) {
      throw new OrchError(`head ${info.head} of ${info.kind} ${info.number} is not reachable after fetching it in ${info.projectPath}`);
    }
    if (baseSha) {
      const m = await deps.git(info.projectPath, ["merge-base", baseSha, info.head]);
      const base = m.stdout.trim();
      if (m.code !== 0 || !base) {
        throw new OrchError(`no merge base between ${baseSha} and ${info.head} in ${info.projectPath}: ${m.stderr.trim()}`);
      }
      info.base = base;
    }
  }
  return info;
}
