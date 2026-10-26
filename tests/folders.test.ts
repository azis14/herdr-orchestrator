import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { OrchError } from "../src/errors";
import { listFolders, resolveFolder } from "../src/folders";
import { gitRunner, type GitRunner } from "../src/git";
import { testRegistry } from "./fakes";

const tmp = (name: string) => fs.mkdtempSync(path.join(os.tmpdir(), `orch-${name}-`));

function porcelain(entries: { path: string; head?: string; branch?: string; detached?: boolean }[]): string {
  return entries
    .map((e) =>
      [`worktree ${e.path}`, `HEAD ${e.head ?? "1111111111111111111111111111111111111111"}`, e.detached ? "detached" : `branch refs/heads/${e.branch}`].join("\n"),
    )
    .join("\n\n") + "\n";
}

const gitReturning = (stdout: string, code = 0, stderr = ""): GitRunner => async () => ({ code, stdout, stderr });

describe("listFolders", () => {
  test("parses porcelain: base first, branches, detached", async () => {
    const p = testRegistry(["shop-api"]).projects[0];
    const [wt1, wt2] = [tmp("wt1"), tmp("wt2")];
    const git = gitReturning(
      porcelain([
        { path: p.path, branch: "dev" },
        { path: wt1, branch: "feature/a" },
        { path: wt2, head: "abc1234def5678900000000000000000000000000", detached: true },
      ]),
    );
    expect(await listFolders(git, p)).toEqual([
      { path: p.path, branch: "dev", base: true },
      { path: wt1, branch: "feature/a", base: false },
      { path: wt2, branch: "detached @ abc1234", base: false },
    ]);
  });

  test("drops worktrees whose path is gone", async () => {
    const p = testRegistry(["shop-api"]).projects[0];
    const wt1 = tmp("wt1");
    const git = gitReturning(
      porcelain([
        { path: p.path, branch: "dev" },
        { path: wt1, branch: "feature/a" },
        { path: "/nonexistent/orch-gone", branch: "feature/gone" },
      ]),
    );
    expect((await listFolders(git, p)).map((f) => f.path)).toEqual([p.path, wt1]);
  });

  test("falls back to the base folder when git fails", async () => {
    const p = testRegistry(["shop-api"]).projects[0];
    const git = gitReturning("", 128, "fatal: not a git repository");
    expect(await listFolders(git, p)).toEqual([{ path: p.path, branch: null, base: true }]);
  });

  test("never lists the base twice", async () => {
    const p = testRegistry(["shop-api"]).projects[0];
    const wt1 = tmp("wt1");
    const git = gitReturning(porcelain([{ path: p.path, branch: "main" }, { path: wt1, branch: "x" }]));
    expect((await listFolders(git, p)).filter((f) => f.base)).toHaveLength(1);
    expect((await listFolders(git, p)).filter((f) => f.path === p.path)).toHaveLength(1);
  });
});

describe("resolveFolder", () => {
  test("no folder: the base, with no git call", async () => {
    const p = testRegistry(["shop-api"]).projects[0];
    const git: GitRunner = async () => {
      throw new Error("git must not be called");
    };
    expect(await resolveFolder(git, p)).toEqual({ path: p.path, branch: null, base: true });
  });

  test("accepts a trailing slash", async () => {
    const p = testRegistry(["shop-api"]).projects[0];
    const wt1 = tmp("wt1");
    const git = gitReturning(porcelain([{ path: p.path, branch: "dev" }, { path: wt1, branch: "feature/a" }]));
    expect(await resolveFolder(git, p, wt1 + "/")).toEqual({ path: wt1, branch: "feature/a", base: false });
  });

  test("refuses a folder that isn't the project's", async () => {
    const p = testRegistry(["shop-api"]).projects[0];
    const wt1 = tmp("wt1");
    const git = gitReturning(porcelain([{ path: p.path, branch: "dev" }, { path: wt1, branch: "feature/a" }]));
    const err = await resolveFolder(git, p, "/tmp").catch((e) => e);
    expect(err).toBeInstanceOf(OrchError);
    expect(err.message).toMatch(/is not a folder of shop-api/);
    expect(err.message).toContain(p.path);
    expect(err.message).toContain(wt1);
  });
});

describe("listFolders with real git", () => {
  /** A real repo with one linked worktree, in a temp dir. */
  async function repoWithWorktree() {
    const root = fs.realpathSync(tmp("git"));
    const repo = path.join(root, "repo");
    const sh = (cwd: string, ...args: string[]) => {
      const r = Bun.spawnSync(["git", "-C", cwd, ...args], { stderr: "pipe" });
      if (r.exitCode !== 0) throw new Error(r.stderr.toString());
    };
    fs.mkdirSync(path.join(repo, "apps", "ui"), { recursive: true });
    fs.writeFileSync(path.join(repo, "apps", "ui", "x.txt"), "x");
    sh(root, "init", "-q", "-b", "main", repo);
    sh(repo, "-c", "user.name=t", "-c", "user.email=t@t", "add", ".");
    sh(repo, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init");
    sh(repo, "worktree", "add", "-q", "-b", "feature/x", path.join(root, "wt"));
    return { root, repo, wt: path.join(root, "wt") };
  }
  const project = (p: string) => ({ name: "shop-api", path: p, description: "", context: [] });

  test("a project at a repo's subfolder gets only its own folder", async () => {
    const { repo } = await repoWithWorktree();
    const sub = path.join(repo, "apps", "ui");
    expect(await listFolders(gitRunner, project(sub))).toEqual([{ path: sub, branch: null, base: true }]);
    expect(await resolveFolder(gitRunner, project(sub), repo).catch((e) => e)).toBeInstanceOf(OrchError);
  });

  test("a symlinked project path isn't listed twice", async () => {
    const { root, repo, wt } = await repoWithWorktree();
    const link = path.join(root, "link");
    fs.symlinkSync(repo, link);
    expect(await listFolders(gitRunner, project(link))).toEqual([
      { path: link, branch: "main", base: true },
      { path: wt, branch: "feature/x", base: false },
    ]);
  });
});
