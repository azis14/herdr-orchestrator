import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Deps } from "../orch";
import { findStale, formatStale, removeWorktrees, resolveRepo, type WtListing } from "../src/cleanwt";
import { OrchError } from "../src/errors";
import { gitRunner, type GitRunner } from "../src/git";
import type { JobAgent } from "../src/jobs";
import { gitFixture as fixture, ok, sh, testDeps, testRegistry, type FakeHandler } from "./fakes";

const DAY = 86_400_000;
const WEEK = 7 * DAY;
const PICK = /^[0-9a-f]{8}@[0-9a-f]{8}$/;

const tmp = (name: string) => fs.mkdtempSync(path.join(os.tmpdir(), `orch-${name}-`));

/** Deps on the real repo: real git, faked Herdr (no panes, no worktrees open) and sizes. `old` puts now 8 days ahead. */
function depsFor(
  repo: string,
  o: { old?: boolean; handlers?: Record<string, FakeHandler>; overrides?: Partial<Deps> } = {},
) {
  const sized: string[] = [];
  const { deps, run } = testDeps(
    { "pane list": () => ok({ panes: [] }), "worktree list": () => ok({ worktrees: [] }), ...o.handlers },
    {
      reg: { ...testRegistry([]), projects: [{ name: "shop", path: repo, description: "shop", context: [] }] },
      git: gitRunner,
      size: async (dir) => {
        sized.push(dir);
        return 1_000_000;
      },
      now: o.old === false ? () => new Date() : () => new Date(Date.now() + 8 * DAY),
      ...o.overrides,
    },
  );
  return { d: deps, sized, run };
}

const repoOf = (repo: string) => ({ name: "shop", path: repo });

function writeJob(root: string, id: string, stage: string, agents: Partial<JobAgent>[]) {
  const dir = path.join(root, "jobs", id);
  fs.mkdirSync(dir, { recursive: true });
  const job = {
    id,
    title: id,
    request: "r",
    projects: ["shop"],
    stage,
    createdAt: new Date().toISOString(),
    agents: agents.map((a, i) => ({
      project: "shop",
      agent: "claude",
      agentName: `shop-${id}-${i}`,
      workspaceId: "w1",
      tabId: "w1:t1",
      paneId: "w1:p1",
      mode: "herdr-worktree",
      status: "started",
      ...a,
    })),
  };
  fs.writeFileSync(path.join(dir, "job.json"), JSON.stringify(job, null, 2));
}

describe("resolveRepo", () => {
  test('a project name, a path inside a worktree, and "." all resolve to the main repo', async () => {
    const { repo, add } = fixture();
    const wt = add("a");
    const { d } = depsFor(repo);
    expect(await resolveRepo(d, "shop")).toEqual({ name: "shop", path: repo });
    expect(await resolveRepo(d, path.join(wt, "apps", "ui"))).toEqual({ name: "shop", path: repo });
    const cwd = process.cwd();
    try {
      process.chdir(wt);
      expect(await resolveRepo(d, ".")).toEqual({ name: "shop", path: repo });
    } finally {
      process.chdir(cwd);
    }
  });

  test("an unregistered repo resolves with no name", async () => {
    const { repo } = fixture();
    const { d } = depsFor(repo, { overrides: { reg: testRegistry([]) } });
    expect(await resolveRepo(d, repo)).toEqual({ name: null, path: repo });
  });

  test("resolveRepo: a non-directory target is an OrchError", async () => {
    const { root, repo } = fixture();
    const { d } = depsFor(repo);
    for (const target of [path.join(repo, "README"), path.join(root, "nope")]) {
      const err = await resolveRepo(d, target).catch((e) => e);
      expect(err).toBeInstanceOf(OrchError);
      expect(err.message).toBe(`"${target}" is neither a project nor a directory. Known projects: shop`);
    }
  });

  test("a dir outside git, or a bare repo, is an OrchError", async () => {
    const { root, repo } = fixture();
    const { d } = depsFor(repo);
    const plain = fs.realpathSync(tmp("plain"));
    const err = await resolveRepo(d, plain).catch((e) => e);
    expect(err).toBeInstanceOf(OrchError);
    expect(err.message).toBe(`"${plain}" is not in a git repo`);
    const bare = await resolveRepo(d, path.join(root, "origin.git")).catch((e) => e);
    expect(bare).toBeInstanceOf(OrchError);
    expect(bare.message).toBe("bare repositories aren't supported");
  });
});

describe("findStale", () => {
  test("the main checkout is never listed", async () => {
    const { repo } = fixture();
    const { d } = depsFor(repo);
    const l = await findStale(d, repoOf(repo), { idleMs: WEEK });
    expect(l.candidates).toEqual([]);
    expect(l.skipped).toEqual([]);
    expect(l.recent).toBe(0);
  });

  test("a worktree untouched for 8 days is a candidate with size and pick", async () => {
    const { repo, add } = fixture();
    const wt = add("a");
    const { d, sized } = depsFor(repo);
    const l = await findStale(d, repoOf(repo), { idleMs: WEEK });
    expect(l.repo).toEqual(repoOf(repo));
    expect(l.idleMs).toBe(WEEK);
    expect(l.candidates).toHaveLength(1);
    const c = l.candidates[0];
    expect(c).toMatchObject({ path: wt, branch: "feature/a", bytes: 1_000_000, warnings: [] });
    expect(c.idleMs).toBeGreaterThanOrEqual(8 * DAY - 60_000);
    expect(c.idleMs).toBeLessThanOrEqual(8 * DAY + 60_000);
    expect(c.pick).toMatch(PICK);
    expect(sized).toEqual([wt]);
    expect(l.totalBytes).toBe(1_000_000);
    expect(l.skipped).toEqual([]);
    expect(l.jobWarnings).toEqual([]);
  });

  test("a worktree touched today counts as recent, not listed", async () => {
    const { repo, add } = fixture();
    add("a");
    const { d, sized, run } = depsFor(repo, { old: false });
    const l = await findStale(d, repoOf(repo), { idleMs: WEEK });
    expect(l.candidates).toEqual([]);
    expect(l.skipped).toEqual([]);
    expect(l.recent).toBe(1);
    expect(sized).toEqual([]);
    expect(run.calls).toEqual([]); // nothing old: Herdr isn't asked
  });

  test("uncommitted and unpushed work gives exact warnings", async () => {
    const { repo, add } = fixture();
    const wt = add("a");
    for (const n of [1, 2]) {
      fs.writeFileSync(path.join(wt, `c${n}.txt`), String(n));
      sh(wt, "add", ".");
      sh(wt, "commit", "-qm", `c${n}`);
    }
    fs.writeFileSync(path.join(wt, "README"), "changed");
    const { d } = depsFor(repo);
    const l = await findStale(d, repoOf(repo), { idleMs: WEEK });
    expect(l.candidates.map((c) => c.warnings)).toEqual([["1 uncommitted file", "2 commits not pushed"]]);
  });

  test("a tracked dir replaced by a file of the same name still lists, warned uncommitted", async () => {
    const { repo, add } = fixture();
    const wt = add("a");
    fs.rmSync(path.join(wt, "apps"), { recursive: true });
    fs.writeFileSync(path.join(wt, "apps"), "now a file"); // status names apps/ui/x.txt: lstat on it is ENOTDIR
    const { d } = depsFor(repo);
    const l = await findStale(d, repoOf(repo), { idleMs: WEEK });
    expect(l.candidates.map((c) => c.path)).toEqual([wt]);
    expect(l.candidates[0].warnings).toEqual(["2 uncommitted files"]); // ` D apps/ui/x.txt` and `?? apps`
  });

  test("untracked files in a new dir count each file", async () => {
    const { repo, add } = fixture();
    const wt = add("a");
    fs.mkdirSync(path.join(wt, "newdir"));
    fs.writeFileSync(path.join(wt, "newdir", "one.txt"), "1");
    fs.writeFileSync(path.join(wt, "newdir", "two.txt"), "2");
    const { d } = depsFor(repo);
    const l = await findStale(d, repoOf(repo), { idleMs: WEEK });
    expect(l.candidates.map((c) => c.warnings)).toEqual([["2 uncommitted files"]]);
  });

  test("a detached worktree is warned detached HEAD", async () => {
    const { repo, add } = fixture();
    add("d", { detach: true });
    const { d } = depsFor(repo);
    const l = await findStale(d, repoOf(repo), { idleMs: WEEK });
    expect(l.candidates).toHaveLength(1);
    expect(l.candidates[0].branch).toMatch(/^detached @ [0-9a-f]{7}$/);
    expect(l.candidates[0].warnings).toEqual(["detached HEAD"]);
  });

  test("a locked worktree is skipped as locked", async () => {
    const { repo, add } = fixture();
    const wt = add("a", { lock: true });
    const { d, sized } = depsFor(repo);
    const l = await findStale(d, repoOf(repo), { idleMs: WEEK });
    expect(l.candidates).toEqual([]);
    expect(l.skipped).toEqual([{ path: wt, branch: "feature/a", reason: "locked" }]);
    expect(sized).toEqual([]);
  });

  test("an unfinished job's worktreePath and lastCwd block their worktrees; a done job's don't", async () => {
    const { repo, add } = fixture();
    const [a, b, c] = [add("a"), add("b"), add("c")];
    const { d } = depsFor(repo);
    writeJob(d.root, "20261101-open", "build", [{ worktreePath: a }, { lastCwd: path.join(b, "apps", "ui") }]);
    writeJob(d.root, "20261101-done", "done", [{ worktreePath: c }]);
    const l = await findStale(d, repoOf(repo), { idleMs: WEEK });
    expect(l.candidates.map((x) => x.path)).toEqual([c]);
    expect(l.skipped).toEqual([
      { path: a, branch: "feature/a", reason: "job 20261101-open unfinished" },
      { path: b, branch: "feature/b", reason: "job 20261101-open unfinished" },
    ]);
    expect(l.jobWarnings).toEqual([]);
  });

  test("an unfinished repo-worktree job agent with nothing recorded adds the job warning", async () => {
    const { repo, add } = fixture();
    add("a");
    const { d } = depsFor(repo);
    writeJob(d.root, "20261102-mono", "build", [{ mode: "repo-worktree" }, { mode: "repo-worktree", project: "other" }]);
    writeJob(d.root, "20261102-done", "done", [{ mode: "repo-worktree" }]);
    const l = await findStale(d, repoOf(repo), { idleMs: WEEK });
    expect(l.jobWarnings).toEqual([
      "warning: job 20261102-mono is unfinished and its worktree isn't recorded; check before picking",
    ]);
    expect(l.candidates).toHaveLength(1);
  });

  test("a pane in a subfolder blocks its worktree", async () => {
    const { repo, add } = fixture();
    const [a, ab] = [add("a"), add("a-b")];
    const { d } = depsFor(repo, {
      handlers: {
        "pane list": () =>
          ok({ panes: [{ pane_id: "w1:p2", tab_id: "w1:t1", workspace_id: "w1", cwd: "/", foreground_cwd: `${a}/apps` }] }),
      },
    });
    const l = await findStale(d, repoOf(repo), { idleMs: WEEK });
    expect(l.skipped).toEqual([{ path: a, branch: "feature/a", reason: "open in Herdr (pane w1:p2)" }]);
    expect(l.candidates.map((x) => x.path)).toEqual([ab]);
  });

  test("a Herdr workspace open on the worktree blocks it", async () => {
    const { repo, add } = fixture();
    const [a, b] = [add("a"), add("b")];
    const { d, run } = depsFor(repo, {
      handlers: {
        "worktree list": () =>
          ok({
            worktrees: [
              { path: repo, is_linked_worktree: false, open_workspace_id: "w1" },
              { path: a, is_linked_worktree: true, open_workspace_id: "w7" },
              { path: b, is_linked_worktree: true },
            ],
          }),
      },
    });
    const l = await findStale(d, repoOf(repo), { idleMs: WEEK });
    expect(l.skipped).toEqual([{ path: a, branch: "feature/a", reason: "open in Herdr (workspace w7)" }]);
    expect(l.candidates.map((x) => x.path)).toEqual([b]);
    expect(run.calls).toContainEqual(["worktree", "list", "--cwd", repo]);
  });

  test("Herdr failing skips every old worktree as Herdr unavailable", async () => {
    const { repo, add } = fixture();
    const [a, b] = [add("a"), add("b")];
    const { d, sized } = depsFor(repo, { handlers: { "pane list": () => ({ code: 1, stderr: "server not running" }) } });
    const l = await findStale(d, repoOf(repo), { idleMs: WEEK });
    expect(l.candidates).toEqual([]);
    expect(l.skipped).toEqual([
      { path: a, branch: "feature/a", reason: "Herdr unavailable" },
      { path: b, branch: "feature/b", reason: "Herdr unavailable" },
    ]);
    expect(sized).toEqual([]);
  });

  test("listing twice gives the same picks", async () => {
    const { repo, add } = fixture();
    const [a, b] = [add("a"), add("b")];
    fs.writeFileSync(path.join(a, "README"), "changed"); // a dirty index entry: a plain `git status` would rewrite the index
    fs.writeFileSync(path.join(b, "new.txt"), "new");
    const { d } = depsFor(repo);
    const first = await findStale(d, repoOf(repo), { idleMs: WEEK });
    const second = await findStale(d, repoOf(repo), { idleMs: WEEK });
    expect(first.candidates).toHaveLength(2);
    expect(second.candidates.map((c) => c.pick)).toEqual(first.candidates.map((c) => c.pick));
  });

  test("a worktree whose age can't be read is listed last with age unknown", async () => {
    const { repo, add } = fixture();
    const [a, b] = [add("a"), add("b")];
    const git: GitRunner = async (cwd, args, o) =>
      cwd === a && (args[0] === "log" || args.includes("--absolute-git-dir"))
        ? { code: 128, stdout: "", stderr: "fatal: nope" }
        : gitRunner(cwd, args, o);
    const { d } = depsFor(repo, { overrides: { git } });
    const l = await findStale(d, repoOf(repo), { idleMs: WEEK });
    expect(l.candidates.map((c) => c.path)).toEqual([b, a]);
    expect(l.candidates[1].idleMs).toBeNull();
    expect(l.candidates[1].warnings).toContain("age unknown");
  });

  test("a worktree path with a space lists with a space-free pick", async () => {
    const { repo, add } = fixture();
    const wt = add("with space");
    const { d } = depsFor(repo);
    const l = await findStale(d, repoOf(repo), { idleMs: WEEK });
    expect(l.candidates.map((c) => c.path)).toEqual([wt]);
    expect(l.candidates[0].pick).toMatch(PICK);
    expect(l.candidates[0].pick).not.toContain(" ");
  });

  test("a worktree whose git status fails is skipped with the reason", async () => {
    const { repo, add } = fixture();
    const a = add("a");
    const git: GitRunner = async (cwd, args, o) =>
      cwd === a && args.includes("status") ? { code: 128, stdout: "", stderr: "fatal: index corrupt\n" } : gitRunner(cwd, args, o);
    const { d } = depsFor(repo, { overrides: { git } });
    const l = await findStale(d, repoOf(repo), { idleMs: WEEK });
    expect(l.skipped).toEqual([{ path: a, branch: "feature/a", reason: "git status failed: fatal: index corrupt" }]);
    expect(l.candidates).toEqual([]);
  });
});

describe("formatStale", () => {
  test("formatStale prints the table, total line, skipped block, recent count and job warning", () => {
    const l: WtListing = {
      repo: { name: "shop", path: "/r/shop" },
      idleMs: WEEK,
      candidates: [
        {
          path: "/r/shop.worktrees/old",
          branch: "feature/old",
          idleMs: 10 * DAY,
          bytes: 2 * 1024 ** 3,
          warnings: ["1 uncommitted file"],
          pick: "aaaaaaaa@11111111",
        },
        {
          path: "/r/wt-b",
          branch: "feature/b",
          idleMs: 8 * DAY + 3 * 3_600_000,
          bytes: 477 * 1024 ** 2,
          warnings: [],
          pick: "bbbbbbbb@22222222",
        },
        {
          path: "/r/shop.worktrees/x y",
          branch: "detached @ abc1234",
          idleMs: null,
          bytes: null,
          warnings: ["detached HEAD", "age unknown"],
          pick: "cccccccc@33333333",
        },
      ],
      skipped: [
        { path: "/r/shop.worktrees/locked", branch: "feature/l", reason: "locked" },
        { path: "/r/shop.worktrees/open", branch: "feature/o", reason: "open in Herdr (pane w1:p2)" },
      ],
      recent: 4,
      jobWarnings: ["warning: job 20261101-x is unfinished and its worktree isn't recorded; check before picking"],
      totalBytes: 2 * 1024 ** 3 + 477 * 1024 ** 2,
    };
    expect(formatStale(l)).toBe(
      [
        "WORKTREE            BRANCH              IDLE     FREES   WARNINGS                    PICK",
        "shop.worktrees/old  feature/old         10d      2.0 GB  1 uncommitted file          aaaaaaaa@11111111",
        "wt-b                feature/b           8d 3h    477 MB  -                           bbbbbbbb@22222222",
        "shop.worktrees/x y  detached @ abc1234  unknown  ?       detached HEAD, age unknown  cccccccc@33333333",
        "about 2.5 GB would be freed (shared pnpm files stay in the pnpm store)",
        "skipped:",
        "  shop.worktrees/locked: locked",
        "  shop.worktrees/open: open in Herdr (pane w1:p2)",
        "4 touched within 7d",
        "warning: job 20261101-x is unfinished and its worktree isn't recorded; check before picking",
      ].join("\n"),
    );
  });

  test("with no candidates it says so, and leaves out the total and empty sections", () => {
    const l: WtListing = {
      repo: { name: null, path: "/r/shop" },
      idleMs: WEEK,
      candidates: [],
      skipped: [],
      recent: 0,
      jobWarnings: [],
      totalBytes: 0,
    };
    expect(formatStale(l)).toBe("no worktrees idle for 7d or more");
  });
});

describe("removeWorktrees", () => {
  /** The pick findStale lists for each path, in the order given. */
  async function picksFor(d: Deps, repo: string, ...wts: string[]): Promise<string[]> {
    const l = await findStale(d, repoOf(repo), { idleMs: WEEK });
    return wts.map((wt) => l.candidates.find((c) => c.path === wt)!.pick);
  }

  test("removes a picked worktree, keeps its branch, reports bytes", async () => {
    const { repo, add } = fixture();
    const wt = add("a");
    const { d } = depsFor(repo);
    const [pick] = await picksFor(d, repo, wt);
    expect(await removeWorktrees(d, repoOf(repo), [pick])).toEqual({
      removed: [{ path: wt, bytes: 1_000_000 }],
      refused: [],
      freedBytes: 1_000_000,
    });
    expect(fs.existsSync(wt)).toBe(false);
    expect(sh(repo, "branch", "--list", "feature/a")).toContain("feature/a");
    expect(sh(repo, "worktree", "list")).not.toContain(wt);
  });

  test("a pick whose worktree is gone is refused, the rest still go", async () => {
    const { repo, add } = fixture();
    const [a, b] = [add("a"), add("b")];
    const { d } = depsFor(repo);
    const [pa, pb] = await picksFor(d, repo, a, b);
    fs.rmSync(a, { recursive: true, force: true }); // deleted by hand between the listing and --remove
    const r = await removeWorktrees(d, repoOf(repo), [pa, pb]);
    expect(r.refused).toEqual([{ pick: pa, reason: "gone" }]);
    expect(r.removed).toEqual([{ path: b, bytes: 1_000_000 }]);
    expect(r.freedBytes).toBe(1_000_000);
    expect(fs.existsSync(b)).toBe(false);
  });

  test("a pick whose worktree changed since listing is refused", async () => {
    const { repo, add } = fixture();
    const wt = add("a");
    const { d, sized } = depsFor(repo);
    const [pick] = await picksFor(d, repo, wt);
    sized.length = 0;
    fs.writeFileSync(path.join(wt, "README"), "edited after the listing");
    expect(await removeWorktrees(d, repoOf(repo), [pick])).toEqual({
      removed: [],
      refused: [{ pick, path: wt, reason: "changed since listing" }],
      freedBytes: 0,
    });
    expect(fs.existsSync(wt)).toBe(true);
    expect(sized).toEqual([]);
  });

  test("a pick whose worktree opened in Herdr since listing is refused", async () => {
    const { repo, add } = fixture();
    const wt = add("a");
    let panes: unknown[] = [];
    const { d } = depsFor(repo, { handlers: { "pane list": () => ok({ panes }) } });
    const [pick] = await picksFor(d, repo, wt);
    panes = [{ pane_id: "w1:p2", tab_id: "w1:t1", workspace_id: "w1", cwd: wt }];
    const r = await removeWorktrees(d, repoOf(repo), [pick]);
    expect(r.refused).toEqual([{ pick, path: wt, reason: "open in Herdr (pane w1:p2)" }]);
    expect(r.removed).toEqual([]);
    expect(fs.existsSync(wt)).toBe(true);
  });

  test("bad and duplicate picks are refused", async () => {
    const { repo, add } = fixture();
    const wt = add("a");
    const { d } = depsFor(repo);
    const [pick] = await picksFor(d, repo, wt);
    const samePath = `${pick.split("@")[0]}@00000000`;
    const r = await removeWorktrees(d, repoOf(repo), ["junk", "ABCDEF12@12345678", pick, samePath, pick]);
    expect(r.refused).toEqual([
      { pick: "junk", reason: "bad pick" },
      { pick: "ABCDEF12@12345678", reason: "bad pick" },
      { pick: samePath, reason: "duplicate pick" },
      { pick, reason: "duplicate pick" },
    ]);
    expect(r.removed).toEqual([{ path: wt, bytes: 1_000_000 }]);
  });

  test("a worktree path with a space is removed by its pick", async () => {
    const { repo, add } = fixture();
    const wt = add("with space");
    const { d } = depsFor(repo);
    const [pick] = await picksFor(d, repo, wt);
    const r = await removeWorktrees(d, repoOf(repo), [pick]);
    expect(r.removed).toEqual([{ path: wt, bytes: 1_000_000 }]);
    expect(r.refused).toEqual([]);
    expect(fs.existsSync(wt)).toBe(false);
  });

  test("a failing git worktree remove is refused with git's message", async () => {
    const { repo, add } = fixture();
    const wt = add("a");
    const git: GitRunner = async (cwd, args, o) =>
      args[0] === "worktree" && args[1] === "remove"
        ? { code: 128, stdout: "", stderr: "fatal: permission denied\n" }
        : gitRunner(cwd, args, o);
    const { d } = depsFor(repo, { overrides: { git } });
    const [pick] = await picksFor(d, repo, wt);
    expect(await removeWorktrees(d, repoOf(repo), [pick])).toEqual({
      removed: [],
      refused: [{ pick, path: wt, reason: "git worktree remove failed: fatal: permission denied" }],
      freedBytes: 0,
    });
    expect(fs.existsSync(wt)).toBe(true);
  });
});
