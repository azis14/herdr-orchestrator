import { OrchError } from "./errors";
import type { Platform } from "./forge";
import type { GitRunner } from "./git";
import { getProject, type Project, type Registry } from "./registry";

export interface MrRef {
  platform: Platform;
  host: string;
  repo: string;
  number: number;
}
export interface ResolvedRef extends MrRef {
  project: Project;
}

const USAGE = "usage: mr <sub> <MR/PR URL | project id>   (id is 42, !42 or #42)";

/** Only github.com is GitHub; every other host is GitLab. */
const platformOf = (host: string): Platform => (host === "github.com" ? "github" : "gitlab");

/** A GitLab merge request or GitHub pull request URL; anything after the number is ignored. */
export function parseMrUrl(url: string): MrRef | null {
  let u: URL;
  try {
    u = new URL(url.trim());
  } catch {
    return null;
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return null;
  const host = u.hostname.toLowerCase();
  const path = decodeURI(u.pathname);
  if (host === "github.com") {
    const m = path.match(/^\/([^/]+\/[^/]+)\/pull\/(\d+)(?:\/|$)/);
    return m ? { platform: "github", host, repo: m[1], number: Number(m[2]) } : null;
  }
  const m = path.match(/^\/(.+?)(?:\/-)?\/merge_requests\/(\d+)(?:\/|$)/);
  return m ? { platform: "gitlab", host, repo: m[1], number: Number(m[2]) } : null;
}

/** Host and repo path (no `.git`) of a git remote URL, lower-cased: scp-style, ssh:// or http(s)://. */
export function parseRemote(url: string): { host: string; repo: string } | null {
  const s = url.trim();
  let host: string;
  let repo: string;
  const scp = s.match(/^(?:[^@/\s]+@)?([^:/\s]+):(?!\/\/)(.+)$/);
  if (scp) {
    [, host, repo] = scp;
  } else {
    let u: URL;
    try {
      u = new URL(s);
    } catch {
      return null;
    }
    host = u.hostname;
    repo = decodeURI(u.pathname);
  }
  repo = repo.replace(/^\/+|\/+$/g, "").replace(/\.git$/i, "");
  if (!host || !repo) return null;
  return { host: host.toLowerCase(), repo: repo.toLowerCase() };
}

/** args: [url] or [project, id] with id `42`, `!42` or `#42`. */
export async function resolveRef(reg: Registry, git: GitRunner, args: string[]): Promise<ResolvedRef> {
  if (args.length === 1) {
    const ref = parseMrUrl(args[0]);
    if (!ref) throw new OrchError(`${USAGE}\n"${args[0]}" is not a GitLab merge request or GitHub pull request URL`);
    const key = `${ref.host}/${ref.repo}`.toLowerCase();
    const matches: Project[] = [];
    for (const project of reg.projects) {
      const origin = await originOf(git, project);
      if (origin && `${origin.host}/${origin.repo}` === key) matches.push(project);
    }
    if (matches.length === 0) {
      throw new OrchError(
        `no registered project has origin ${ref.host}/${ref.repo}. Register the repo with /register, or check the URL`,
      );
    }
    if (matches.length > 1) {
      throw new OrchError(
        `${matches.map((p) => p.name).join(", ")} all have origin ${ref.host}/${ref.repo}. Name one: mr <sub> <project> <id>`,
      );
    }
    return { ...ref, project: matches[0] };
  }
  if (args.length === 2) {
    const id = args[1].match(/^[!#]?(\d+)$/);
    if (!id) throw new OrchError(`${USAGE}\n"${args[1]}" is not an MR/PR id`);
    const project = getProject(reg, args[0]);
    const origin = await originOf(git, project);
    if (!origin) throw new OrchError(`project ${project.name} has no usable git origin`);
    return { platform: platformOf(origin.host), host: origin.host, repo: origin.repo, number: Number(id[1]), project };
  }
  throw new OrchError(USAGE);
}

async function originOf(git: GitRunner, project: Project): Promise<{ host: string; repo: string } | null> {
  const r = await git(project.path, ["remote", "get-url", "origin"]);
  return r.code === 0 ? parseRemote(r.stdout) : null;
}
