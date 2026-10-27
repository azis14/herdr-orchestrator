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

export interface MrNote {
  id: string;
  author: string;
  body: string;
  createdAt: string;
  system: boolean;
  url: string;
}

export interface MrThread {
  id: string;
  resolvable: boolean;
  resolved: boolean;
  outdated: boolean;
  path: string | null;
  line: number | null;
  side: "new" | "old" | null;
  notes: MrNote[];
}

export interface MrThreads {
  me: string;
  threads: MrThread[];
  notes: MrNote[];
}

const REVIEW_THREADS_QUERY = `query ReviewThreads($owner: String!, $name: String!, $number: Int!, $cursor: String) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      reviewThreads(first: 100, after: $cursor) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id isResolved isOutdated path line originalLine diffSide
          comments(first: 100) { nodes { id body createdAt url author { login } } }
        }
      }
    }
  }
}`;

/** The MR/PR's review threads (resolvable, anchored discussions) and its other comments, normalized across GitLab and GitHub. */
export async function listThreads(deps: MrDeps, mr: MrInfo): Promise<MrThreads> {
  const forge = forgeFor(deps, mr);
  const threads: MrThread[] = [];
  const notes: MrNote[] = [];

  if (mr.platform === "gitlab") {
    const discussions: any[] = await forge.rest("GET", `projects/${encodeRepo(mr.repo)}/merge_requests/${mr.number}/discussions`, undefined, { paginate: true });
    const toNote = (n: any): MrNote => ({
      id: String(n.id),
      author: n.author?.username ?? "",
      body: n.body ?? "",
      createdAt: n.created_at ?? "",
      system: !!n.system,
      url: `${mr.url}#note_${n.id}`,
    });
    for (const d of discussions) {
      const all: any[] = d.notes ?? [];
      const real = all.filter((n) => !n.system).map(toNote);
      const first = all[0];
      if (first?.resolvable) {
        const pos = first.position;
        const side = pos?.new_line != null ? "new" : pos?.old_line != null ? "old" : null;
        threads.push({
          id: String(d.id),
          resolvable: true,
          resolved: !!first.resolved,
          outdated: false,
          path: pos?.new_path ?? pos?.old_path ?? null,
          line: side === "new" ? pos.new_line : side === "old" ? pos.old_line : null,
          side,
          notes: real,
        });
      } else {
        notes.push(...real);
      }
    }
  } else {
    const [owner, name] = mr.repo.split("/");
    let cursor: string | null = null;
    for (;;) {
      const data: any = await forge.graphql(REVIEW_THREADS_QUERY, { owner, name, number: mr.number, cursor });
      const page = data?.repository?.pullRequest?.reviewThreads;
      for (const t of page?.nodes ?? []) {
        threads.push({
          id: t.id,
          resolvable: true,
          resolved: !!t.isResolved,
          outdated: !!t.isOutdated,
          path: t.path ?? null,
          line: t.line ?? t.originalLine ?? null,
          side: t.diffSide === "LEFT" ? "old" : t.diffSide === "RIGHT" ? "new" : null,
          notes: (t.comments?.nodes ?? []).map((c: any): MrNote => ({
            id: String(c.id),
            author: c.author?.login ?? "",
            body: c.body ?? "",
            createdAt: c.createdAt ?? "",
            system: false,
            url: c.url ?? "",
          })),
        });
      }
      if (!page?.pageInfo?.hasNextPage || !page.pageInfo.endCursor) break;
      cursor = page.pageInfo.endCursor;
    }
    const comments: any[] = await forge.rest("GET", `repos/${mr.repo}/issues/${mr.number}/comments`, undefined, { paginate: true });
    for (const c of comments) {
      notes.push({ id: String(c.id), author: c.user?.login ?? "", body: c.body ?? "", createdAt: c.created_at ?? "", system: false, url: c.html_url ?? "" });
    }
    const reviews: any[] = await forge.rest("GET", `repos/${mr.repo}/pulls/${mr.number}/reviews`, undefined, { paginate: true });
    for (const r of reviews) {
      if (!r.body?.trim()) continue;
      notes.push({ id: String(r.id), author: r.user?.login ?? "", body: r.body, createdAt: r.submitted_at ?? "", system: false, url: r.html_url ?? "" });
    }
  }
  return { me: mr.me, threads, notes };
}
