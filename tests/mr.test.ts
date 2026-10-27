import { describe, expect, test } from "bun:test";
import type { GitRunner } from "../src/git";
import { encodeRepo, showMr, type MrDeps } from "../src/mr";
import { fakeForge, testRegistry, type FakeReply } from "./fakes";

type Handlers = Record<string, (args: string[], stdin?: string) => FakeReply>;

/** MrDeps whose first project has the given origin; `gitExtra` answers any other git call. */
function setup(origin: string, forgeHandlers: Handlers, gitExtra: (cwd: string, args: string[]) => FakeReply = () => ({})) {
  const reg = testRegistry(["shop-api"]);
  const gitCalls: { cwd: string; args: string[] }[] = [];
  const git: GitRunner = async (cwd, args) => {
    if (args.join(" ") === "remote get-url origin") return { code: 0, stdout: `${origin}\n`, stderr: "" };
    gitCalls.push({ cwd, args });
    const r = gitExtra(cwd, args);
    return { code: r.code ?? 0, stdout: String(r.stdout ?? ""), stderr: String(r.stderr ?? "") };
  };
  const forge = fakeForge(forgeHandlers);
  const deps: MrDeps = { reg, git, forge };
  return { deps, forge, gitCalls, project: reg.projects[0] };
}

const glMr = (over: Record<string, unknown> = {}) => ({
  web_url: "https://gitlab.acclime.cloud/group/sub/proj/-/merge_requests/42",
  title: "Add login",
  description: "Adds login",
  author: { username: "alice" },
  state: "opened",
  draft: false,
  source_project_id: 7,
  target_project_id: 7,
  source_branch: "feature/login",
  target_branch: "dev",
  sha: "sha-head-fallback",
  diff_refs: { base_sha: "b1", start_sha: "s1", head_sha: "h1" },
  ...over,
});

const glHandlers = (mr: Record<string, unknown> = glMr()): Handlers => ({
  "GET projects/group%2Fsub%2Fproj/merge_requests/42": () => ({ stdout: mr }),
  "GET projects/group%2Fsub%2Fproj": () => ({ stdout: { default_branch: "main" } }),
  "GET user": () => ({ stdout: { username: "me-gl" } }),
});

const ghPr = (over: Record<string, unknown> = {}) => ({
  html_url: "https://github.com/Acme/Shop/pull/9",
  node_id: "PR_node9",
  title: "Fix cart",
  body: null,
  user: { login: "bob" },
  state: "open",
  merged: false,
  draft: true,
  head: { ref: "fix/cart", sha: "ghhead", repo: { full_name: "acme/shop" } },
  base: { ref: "dev", sha: "ghbase", repo: { full_name: "acme/shop", default_branch: "main" } },
  ...over,
});

const ghHandlers = (pr: Record<string, unknown> = ghPr()): Handlers => ({
  "GET repos/acme/shop/pulls/9": () => ({ stdout: pr }),
  "GET user": () => ({ stdout: { login: "me-gh" } }),
});

const GL_URL = "https://gitlab.acclime.cloud/group/sub/proj/-/merge_requests/42";
const GL_ORIGIN = "git@gitlab.acclime.cloud:group/sub/proj.git";
const GH_URL = "https://github.com/acme/shop/pull/9";
const GH_ORIGIN = "git@github.com:acme/shop.git";

describe("encodeRepo", () => {
  test("encodes slashes", () => {
    expect(encodeRepo("a/b")).toBe("a%2Fb");
    expect(encodeRepo("group/sub/proj")).toBe("group%2Fsub%2Fproj");
  });
});

describe("showMr", () => {
  test("normalizes a GitLab MR", async () => {
    const t = setup(GL_ORIGIN, glHandlers());
    const mr = await showMr(t.deps, [GL_URL]);
    expect(mr).toEqual({
      platform: "gitlab",
      host: "gitlab.acclime.cloud",
      repo: "group/sub/proj",
      project: "shop-api",
      projectPath: t.project.path,
      number: 42,
      kind: "mr",
      url: GL_URL,
      title: "Add login",
      description: "Adds login",
      author: "alice",
      state: "open",
      draft: false,
      fork: false,
      sourceBranch: "feature/login",
      targetBranch: "dev",
      defaultBranch: "main",
      head: "h1",
      base: "b1",
      start: "s1",
      me: "me-gl",
      nodeId: null,
    });
    expect(t.forge.calls.every((c) => c.bin === "glab")).toBe(true);
    expect(t.forge.calls[0].args).toEqual([
      "api",
      "--hostname",
      "gitlab.acclime.cloud",
      "--method",
      "GET",
      "projects/group%2Fsub%2Fproj/merge_requests/42",
    ]);
    expect(t.forge.calls.every((c) => c.args.includes("--hostname"))).toBe(true);
  });

  test("maps GitLab states and falls back to sha for head", async () => {
    const locked = await showMr(setup(GL_ORIGIN, glHandlers(glMr({ state: "locked" }))).deps, [GL_URL]);
    expect(locked.state).toBe("closed");
    const merged = await showMr(setup(GL_ORIGIN, glHandlers(glMr({ state: "merged" }))).deps, [GL_URL]);
    expect(merged.state).toBe("merged");
    const noHead = await showMr(setup(GL_ORIGIN, glHandlers(glMr({ diff_refs: { base_sha: "b1", start_sha: "s1" } }))).deps, [GL_URL]);
    expect(noHead.head).toBe("sha-head-fallback");
  });

  test("resolves <project> <id> the same as the URL", async () => {
    const t = setup(GL_ORIGIN, glHandlers());
    const mr = await showMr(t.deps, ["shop-api", "!42"]);
    expect(mr.number).toBe(42);
    expect(mr.repo).toBe("group/sub/proj");
  });

  test("normalizes a GitHub PR", async () => {
    const t = setup(GH_ORIGIN, ghHandlers());
    const mr = await showMr(t.deps, [GH_URL]);
    expect(mr).toEqual({
      platform: "github",
      host: "github.com",
      repo: "acme/shop",
      project: "shop-api",
      projectPath: t.project.path,
      number: 9,
      kind: "pr",
      url: "https://github.com/Acme/Shop/pull/9",
      title: "Fix cart",
      description: "",
      author: "bob",
      state: "open",
      draft: true,
      fork: false,
      sourceBranch: "fix/cart",
      targetBranch: "dev",
      defaultBranch: "main",
      head: "ghhead",
      base: null,
      start: null,
      me: "me-gh",
      nodeId: "PR_node9",
    });
    expect(t.forge.calls.every((c) => c.bin === "gh" && !c.args.includes("--hostname"))).toBe(true);
  });

  test("maps GitHub merged and closed", async () => {
    const merged = await showMr(setup(GH_ORIGIN, ghHandlers(ghPr({ state: "closed", merged: true }))).deps, [GH_URL]);
    expect(merged.state).toBe("merged");
    const closed = await showMr(setup(GH_ORIGIN, ghHandlers(ghPr({ state: "closed" }))).deps, [GH_URL]);
    expect(closed.state).toBe("closed");
  });

  test("marks forks", async () => {
    const gl = await showMr(setup(GL_ORIGIN, glHandlers(glMr({ source_project_id: 8 }))).deps, [GL_URL]);
    expect(gl.fork).toBe(true);
    const gh = await showMr(
      setup(GH_ORIGIN, ghHandlers(ghPr({ head: { ref: "x", sha: "s", repo: { full_name: "carol/shop" } } }))).deps,
      [GH_URL],
    );
    expect(gh.fork).toBe(true);
    const deleted = await showMr(setup(GH_ORIGIN, ghHandlers(ghPr({ head: { ref: "x", sha: "s", repo: null } }))).deps, [GH_URL]);
    expect(deleted.fork).toBe(true);
  });
});

describe("showMr --fetch", () => {
  test("fetches the head ref and the target branch", async () => {
    const t = setup(GL_ORIGIN, glHandlers());
    const mr = await showMr(t.deps, [GL_URL], { fetch: true });
    expect(t.gitCalls).toEqual([
      { cwd: t.project.path, args: ["fetch", "origin", "refs/merge-requests/42/head", "dev"] },
      { cwd: t.project.path, args: ["cat-file", "-e", "h1^{commit}"] },
    ]);
    expect(mr.base).toBe("b1");
  });

  test("on GitHub fetches the pull ref and sets base to the merge base", async () => {
    const t = setup(GH_ORIGIN, ghHandlers(), (_cwd, args) => (args[0] === "merge-base" ? { stdout: "mergebase1\n" } : {}));
    const mr = await showMr(t.deps, [GH_URL], { fetch: true });
    expect(t.gitCalls.map((c) => c.args)).toEqual([
      ["fetch", "origin", "refs/pull/9/head"],
      ["cat-file", "-e", "ghhead^{commit}"],
      ["merge-base", "ghbase", "ghhead"],
    ]);
    expect(mr.base).toBe("mergebase1");
  });

  test("fails when the fetch fails", async () => {
    const t = setup(GL_ORIGIN, glHandlers(), (_cwd, args) => (args[0] === "fetch" ? { code: 128, stderr: "fatal: no remote" } : {}));
    await expect(showMr(t.deps, [GL_URL], { fetch: true })).rejects.toThrow("fatal: no remote");
  });

  test("fails when head is not reachable", async () => {
    const t = setup(GL_ORIGIN, glHandlers(), (_cwd, args) => (args[0] === "cat-file" ? { code: 1 } : {}));
    await expect(showMr(t.deps, [GL_URL], { fetch: true })).rejects.toThrow("h1");
  });
});
