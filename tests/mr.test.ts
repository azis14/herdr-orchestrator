import { describe, expect, test } from "bun:test";
import type { GitRunner } from "../src/git";
import { encodeRepo, listThreads, showMr, type MrDeps } from "../src/mr";
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

  test("on GitHub fetches the pull ref and the target branch, and sets base to the merge base", async () => {
    const t = setup(GH_ORIGIN, ghHandlers(), (_cwd, args) => (args[0] === "merge-base" ? { stdout: "mergebase1\n" } : {}));
    const mr = await showMr(t.deps, [GH_URL], { fetch: true });
    expect(t.gitCalls.map((c) => c.args)).toEqual([
      ["fetch", "origin", "refs/pull/9/head", "dev"],
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
    await expect(showMr(t.deps, [GL_URL], { fetch: true })).rejects.toThrow(/h1.*is not reachable/);
  });
});

describe("listThreads", () => {
  const glNote = (id: number, over: Record<string, unknown> = {}) => ({
    id,
    body: `note ${id}`,
    author: { username: "alice" },
    created_at: `2026-10-0${id}T10:00:00Z`,
    system: false,
    resolvable: false,
    ...over,
  });

  test("GitLab: resolvable discussions become threads, the rest notes, system notes dropped", async () => {
    const t = setup(GL_ORIGIN, {
      ...glHandlers(),
      "GET projects/group%2Fsub%2Fproj/merge_requests/42/discussions": () => ({
        stdout: [
          {
            id: "d1",
            notes: [
              glNote(1, { resolvable: true, resolved: false, position: { new_path: "src/a.ts", new_line: 12, old_line: null } }),
              glNote(2, { author: { username: "bob" } }),
              glNote(3, { system: true, body: "changed the description" }),
            ],
          },
          { id: "d2", notes: [glNote(4, { resolvable: true, resolved: true, position: { old_path: "src/b.ts", new_line: null, old_line: 7 } })] },
          { id: "d3", notes: [glNote(5)] },
          { id: "d4", notes: [glNote(6, { system: true, body: "added 1 commit" })] },
          { id: "d5", notes: [glNote(7, { resolvable: true, resolved: false })] },
        ],
      }),
    });
    const mr = await showMr(t.deps, [GL_URL]);
    const r = await listThreads(t.deps, mr);
    expect(r.me).toBe("me-gl");
    expect(r.threads).toEqual([
      {
        id: "d1",
        resolvable: true,
        resolved: false,
        outdated: false,
        path: "src/a.ts",
        line: 12,
        side: "new",
        notes: [
          { id: "1", author: "alice", body: "note 1", createdAt: "2026-10-01T10:00:00Z", system: false, url: `${GL_URL}#note_1` },
          { id: "2", author: "bob", body: "note 2", createdAt: "2026-10-02T10:00:00Z", system: false, url: `${GL_URL}#note_2` },
        ],
      },
      {
        id: "d2",
        resolvable: true,
        resolved: true,
        outdated: false,
        path: "src/b.ts",
        line: 7,
        side: "old",
        notes: [{ id: "4", author: "alice", body: "note 4", createdAt: "2026-10-04T10:00:00Z", system: false, url: `${GL_URL}#note_4` }],
      },
      { id: "d5", resolvable: true, resolved: false, outdated: false, path: null, line: null, side: null, notes: [expect.objectContaining({ id: "7" })] },
    ]);
    expect(r.notes).toEqual([{ id: "5", author: "alice", body: "note 5", createdAt: "2026-10-05T10:00:00Z", system: false, url: `${GL_URL}#note_5` }]);
    const call = t.forge.calls.find((c) => c.args.includes("projects/group%2Fsub%2Fproj/merge_requests/42/discussions"))!;
    expect(call.args).toContain("--paginate");
  });

  const ghThread = (id: string, over: Record<string, unknown> = {}) => ({
    id,
    isResolved: false,
    isOutdated: false,
    path: "src/cart.ts",
    line: 30,
    originalLine: 28,
    diffSide: "RIGHT",
    comments: {
      nodes: [
        { id: `${id}-c1`, body: "please fix", createdAt: "2026-10-01T09:00:00Z", url: `https://github.com/acme/shop/pull/9#discussion_r${id}`, author: { login: "carol" } },
      ],
    },
    ...over,
  });

  test("GitHub: review threads across two GraphQL pages", async () => {
    const cursors: unknown[] = [];
    const t = setup(GH_ORIGIN, {
      ...ghHandlers(),
      "GET repos/acme/shop/issues/9/comments": () => ({ stdout: [] }),
      "GET repos/acme/shop/pulls/9/reviews": () => ({ stdout: [] }),
      "graphql ReviewThreads": (_args, stdin) => {
        const v = JSON.parse(stdin ?? "{}").variables;
        cursors.push(v.cursor);
        expect(v).toMatchObject({ owner: "acme", name: "shop", number: 9 });
        const page = v.cursor === null || v.cursor === undefined ? 1 : 2;
        return {
          stdout: {
            data: {
              repository: {
                pullRequest: {
                  reviewThreads: {
                    pageInfo: { hasNextPage: page === 1, endCursor: page === 1 ? "cur1" : null },
                    nodes:
                      page === 1
                        ? [ghThread("t1")]
                        : [ghThread("t2", { isResolved: true, isOutdated: true, line: null, originalLine: 5, diffSide: "LEFT", comments: { nodes: [{ id: "x", body: "old", createdAt: "2026-10-02T09:00:00Z", url: "u2", author: null }] } })],
                  },
                },
              },
            },
          },
        };
      },
    });
    const mr = await showMr(t.deps, [GH_URL]);
    const r = await listThreads(t.deps, mr);
    expect(cursors).toEqual([null, "cur1"]);
    expect(r.me).toBe("me-gh");
    expect(r.threads).toEqual([
      {
        id: "t1",
        resolvable: true,
        resolved: false,
        outdated: false,
        path: "src/cart.ts",
        line: 30,
        side: "new",
        notes: [{ id: "t1-c1", author: "carol", body: "please fix", createdAt: "2026-10-01T09:00:00Z", system: false, url: "https://github.com/acme/shop/pull/9#discussion_rt1" }],
      },
      {
        id: "t2",
        resolvable: true,
        resolved: true,
        outdated: true,
        path: "src/cart.ts",
        line: 5,
        side: "old",
        notes: [{ id: "x", author: "", body: "old", createdAt: "2026-10-02T09:00:00Z", system: false, url: "u2" }],
      },
    ]);
    expect(r.notes).toEqual([]);
  });

  test("GitHub: issue comments and non-empty review bodies are notes", async () => {
    const t = setup(GH_ORIGIN, {
      ...ghHandlers(),
      "GET repos/acme/shop/issues/9/comments": () => ({
        stdout: [{ id: 11, body: "looks good overall", user: { login: "dave" }, created_at: "2026-10-05T08:00:00Z", html_url: "https://github.com/acme/shop/pull/9#issuecomment-11" }],
      }),
      "GET repos/acme/shop/pulls/9/reviews": () => ({
        stdout: [
          { id: 21, body: "needs work", user: { login: "erin" }, submitted_at: "2026-10-04T08:00:00Z", html_url: "https://github.com/acme/shop/pull/9#pullrequestreview-21" },
          { id: 22, body: "", user: { login: "erin" }, submitted_at: "2026-10-05T08:00:00Z", html_url: "https://github.com/acme/shop/pull/9#pullrequestreview-22" },
          { id: 23, body: null, user: { login: "frank" }, submitted_at: "2026-10-06T08:00:00Z", html_url: "x" },
        ],
      }),
      "graphql ReviewThreads": () => ({
        stdout: { data: { repository: { pullRequest: { reviewThreads: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] } } } } },
      }),
    });
    const mr = await showMr(t.deps, [GH_URL]);
    const r = await listThreads(t.deps, mr);
    expect(r.threads).toEqual([]);
    // merged in time order: the review body (10-04) comes before the issue comment (10-05)
    expect(r.notes).toEqual([
      { id: "21", author: "erin", body: "needs work", createdAt: "2026-10-04T08:00:00Z", system: false, url: "https://github.com/acme/shop/pull/9#pullrequestreview-21" },
      { id: "11", author: "dave", body: "looks good overall", createdAt: "2026-10-05T08:00:00Z", system: false, url: "https://github.com/acme/shop/pull/9#issuecomment-11" },
    ]);
    for (const c of t.forge.calls.filter((c) => c.args.includes("--method") && c.args.some((a) => /issues|reviews/.test(a)))) {
      expect(c.args).toContain("--paginate");
    }
  });

  test("GitHub: a thread with more than 100 comments fails loudly", async () => {
    const t = setup(GH_ORIGIN, {
      ...ghHandlers(),
      "graphql ReviewThreads": () => ({
        stdout: {
          data: {
            repository: {
              pullRequest: {
                reviewThreads: {
                  pageInfo: { hasNextPage: false, endCursor: null },
                  nodes: [ghThread("t9", { comments: { pageInfo: { hasNextPage: true }, nodes: [] } })],
                },
              },
            },
          },
        },
      }),
    });
    const mr = await showMr(t.deps, [GH_URL]);
    await expect(listThreads(t.deps, mr)).rejects.toThrow("review thread t9 on src/cart.ts has more than 100 comments; orch can't list it yet");
  });
});
