import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { GitRunner } from "../src/git";
import type { MrInfo } from "../src/mr";
import { prepareFixWorktree } from "../src/mrworktree";
import { testRegistry } from "./fakes";

const mrInfo = (over: Partial<MrInfo> = {}): MrInfo =>
  ({
    platform: "github", host: "github.com", repo: "acme/shop", project: "shop-api", projectPath: "",
    number: 9, kind: "pr", url: "u", title: "t", description: "", author: "bob", state: "open", draft: false,
    fork: false, sourceBranch: "fix/cart", targetBranch: "dev", defaultBranch: "main", head: "abc", base: null,
    start: null, me: "me", nodeId: null, ...over,
  }) as MrInfo;

const ok = (stdout = "") => ({ code: 0, stdout, stderr: "" });
const fail = (stderr: string) => ({ code: 1, stdout: "", stderr });

interface Setup {
  /** Extra worktrees (path, branch) beside the base. */
  worktrees?: { path: string; branch: string }[];
  baseBranch?: string;
  localBranch?: boolean;
  dirty?: boolean;
  /** Local commits on the branch that origin doesn't have. */
  ahead?: number;
  pull?: { code: number; stdout: string; stderr: string; timedOut?: boolean };
  fetch?: { code: number; stdout: string; stderr: string; timedOut?: boolean };
  /** Reuse an existing project (default: a fresh one). */
  project?: ReturnType<typeof testRegistry>["projects"][number];
}

function setup(s: Setup = {}) {
  const project = s.project ?? testRegistry(["shop-api"]).projects[0];
  const calls: { cwd: string; args: string[] }[] = [];
  const timeouts: { args: string[]; timeoutMs?: number }[] = [];
  const list =
    [{ path: project.path, branch: s.baseBranch ?? "dev" }, ...(s.worktrees ?? [])]
      .map((w) => `worktree ${w.path}\nHEAD 1111111111111111111111111111111111111111\nbranch refs/heads/${w.branch}`)
      .join("\n\n") + "\n";
  const git: GitRunner = async (cwd, args, o) => {
    calls.push({ cwd, args });
    if (o) timeouts.push({ args, ...o });
    const cmd = args.join(" ");
    if (cmd === "worktree list --porcelain") return ok(list);
    if (args[0] === "fetch") return s.fetch ?? ok();
    if (args[0] === "rev-parse") return s.localBranch ? ok("abc\n") : { code: 1, stdout: "", stderr: "" };
    if (args[0] === "status") return ok(s.dirty ? " M a.ts\n" : "");
    if (args[0] === "pull") return s.pull ?? ok("Already up to date.\n");
    if (args[0] === "rev-list") return ok(`${s.ahead ?? 0}\n`);
    return ok();
  };
  return { project, git, calls, timeouts, wtDir: `${project.path}.worktrees/pr-9` };
}

const mutating = (calls: { args: string[] }[]) =>
  calls.filter((c) => ["stash", "reset", "checkout", "switch", "clean"].includes(c.args[0]) || c.args.includes("--force") || c.args.includes("-f"));

describe("prepareFixWorktree", () => {
  test("refuses closed, fork and protected", async () => {
    const t = setup();
    const run = (mr: Partial<MrInfo>, protect?: string[]) => prepareFixWorktree(t.git, t.project, mrInfo(mr), { protect });
    await expect(run({ state: "merged" })).rejects.toThrow("merged");
    await expect(run({ state: "closed" })).rejects.toThrow("closed");
    await expect(run({ fork: true })).rejects.toThrow("fork");
    await expect(run({ sourceBranch: "dev" })).rejects.toThrow("protected");
    await expect(run({ sourceBranch: "main" })).rejects.toThrow("protected");
    await expect(run({ sourceBranch: "master" })).rejects.toThrow("protected");
    await expect(run({ sourceBranch: "release/1", targetBranch: "release/1" })).rejects.toThrow("protected");
    await expect(run({ sourceBranch: "trunk", defaultBranch: "trunk" })).rejects.toThrow("protected");
    await expect(run({ sourceBranch: "staging" }, ["staging", "x"])).rejects.toThrow("protected");
    expect(t.calls).toEqual([]);
  });

  test("refuses when the branch is checked out in the base folder", async () => {
    const t = setup({ baseBranch: "fix/cart" });
    await expect(prepareFixWorktree(t.git, t.project, mrInfo())).rejects.toThrow(t.project.path);
    expect(t.calls.some((c) => c.args[0] === "worktree" && c.args[1] === "add")).toBe(false);
    expect(mutating(t.calls)).toEqual([]);
  });

  test("reuses a worktree that already has the branch", async () => {
    const wt = fs.mkdtempSync(path.join(os.tmpdir(), "orch-wt-"));
    const t = setup({ worktrees: [{ path: wt, branch: "fix/cart" }] });
    expect(await prepareFixWorktree(t.git, t.project, mrInfo())).toEqual({ path: wt, branch: "fix/cart", created: false });
    expect(t.calls.some((c) => c.args[0] === "worktree" && c.args[1] === "add")).toBe(false);
    expect(t.calls).toContainEqual({ cwd: wt, args: ["status", "--porcelain"] });
    expect(t.calls.at(-2)).toEqual({ cwd: wt, args: ["pull", "--ff-only", "origin", "fix/cart"] });
    expect(t.calls.at(-1)).toEqual({ cwd: wt, args: ["rev-list", "--count", "refs/remotes/origin/fix/cart..HEAD"] });
  });

  test("creates from origin when there is no local branch", async () => {
    const t = setup();
    expect(await prepareFixWorktree(t.git, t.project, mrInfo())).toEqual({ path: t.wtDir, branch: "fix/cart", created: true });
    expect(t.calls[0]).toEqual({ cwd: t.project.path, args: ["fetch", "origin", "fix/cart"] });
    expect(t.calls).toContainEqual({ cwd: t.project.path, args: ["worktree", "add", "--track", "-b", "fix/cart", t.wtDir, "origin/fix/cart"] });
    expect(t.calls.at(-2)).toEqual({ cwd: t.wtDir, args: ["pull", "--ff-only", "origin", "fix/cart"] });
    expect(t.calls.at(-1)).toEqual({ cwd: t.wtDir, args: ["rev-list", "--count", "refs/remotes/origin/fix/cart..HEAD"] });
    expect(mutating(t.calls)).toEqual([]);
  });

  test("creates from the local branch when it exists", async () => {
    const t = setup({ localBranch: true });
    expect(await prepareFixWorktree(t.git, t.project, mrInfo())).toEqual({ path: t.wtDir, branch: "fix/cart", created: true });
    expect(t.calls).toContainEqual({ cwd: t.project.path, args: ["rev-parse", "--verify", "--quiet", "refs/heads/fix/cart"] });
    expect(t.calls).toContainEqual({ cwd: t.project.path, args: ["worktree", "add", t.wtDir, "fix/cart"] });
    expect(t.calls.some((c) => c.args.includes("--track"))).toBe(false);
  });

  test("refuses an existing fix path that isn't one of the project's worktrees", async () => {
    const t = setup();
    fs.mkdirSync(t.wtDir, { recursive: true });
    try {
      await expect(prepareFixWorktree(t.git, t.project, mrInfo())).rejects.toThrow("not a worktree");
      expect(t.calls.some((c) => c.args[0] === "worktree" && c.args[1] === "add")).toBe(false);
      expect(mutating(t.calls)).toEqual([]);
    } finally {
      fs.rmSync(path.dirname(t.wtDir), { recursive: true, force: true });
    }
  });

  test("refuses when the fix path is a project worktree on a different branch", async () => {
    const t = setup();
    fs.mkdirSync(t.wtDir, { recursive: true });
    const other = setup({ project: t.project, worktrees: [{ path: t.wtDir, branch: "feature/other" }] });
    try {
      await expect(prepareFixWorktree(other.git, t.project, mrInfo())).rejects.toThrow("feature/other");
      expect(other.calls.some((c) => c.args[0] === "worktree" && c.args[1] === "add")).toBe(false);
      expect(other.calls.some((c) => c.args[0] === "pull")).toBe(false);
      expect(mutating(other.calls)).toEqual([]);
    } finally {
      fs.rmSync(path.dirname(t.wtDir), { recursive: true, force: true });
    }
  });

  test("refuses a source branch starting with a dash", async () => {
    const t = setup();
    await expect(prepareFixWorktree(t.git, t.project, mrInfo({ sourceBranch: "-evil" }))).rejects.toThrow("usable source branch");
    expect(t.calls).toEqual([]);
  });

  test("names a just-created worktree when it then fails", async () => {
    const dirty = setup({ dirty: true });
    await expect(prepareFixWorktree(dirty.git, dirty.project, mrInfo())).rejects.toThrow(`created ${dirty.wtDir}; `);
    const pulled = setup({ pull: fail("fatal: Not possible to fast-forward, aborting.") });
    await expect(prepareFixWorktree(pulled.git, pulled.project, mrInfo())).rejects.toThrow(`created ${pulled.wtDir}; `);
  });

  test("refuses when the fetch fails", async () => {
    const t = setup({ fetch: fail("fatal: couldn't find remote ref fix/cart") });
    await expect(prepareFixWorktree(t.git, t.project, mrInfo())).rejects.toThrow("couldn't find remote ref");
  });

  test("a fetch or pull that hangs times out with a clear error", async () => {
    const hung = { code: 124, stdout: "", stderr: "", timedOut: true };
    const f = setup({ fetch: hung });
    await expect(prepareFixWorktree(f.git, f.project, mrInfo())).rejects.toThrow(
      "git fetch origin fix/cart timed out after 60s; check that origin is reachable",
    );
    expect(f.calls.some((c) => c.args[0] === "worktree" && c.args[1] === "add")).toBe(false);
    const p = setup({ pull: hung });
    await expect(prepareFixWorktree(p.git, p.project, mrInfo())).rejects.toThrow(
      "git pull --ff-only origin fix/cart timed out after 60s; check that origin is reachable",
    );
    expect(p.timeouts).toEqual([
      { args: ["fetch", "origin", "fix/cart"], timeoutMs: 60_000 },
      { args: ["pull", "--ff-only", "origin", "fix/cart"], timeoutMs: 60_000 },
    ]);
  });

  test("refuses a branch with local commits origin doesn't have, and never resets it", async () => {
    const wt = fs.mkdtempSync(path.join(os.tmpdir(), "orch-wt-"));
    try {
      const t = setup({ worktrees: [{ path: wt, branch: "fix/cart" }], ahead: 2 });
      await expect(prepareFixWorktree(t.git, t.project, mrInfo())).rejects.toThrow(
        "fix/cart has local commits not on origin (2 ahead); push or drop them yourself first — /mr-fix won't publish them",
      );
      expect(t.calls.at(-1)).toEqual({ cwd: wt, args: ["rev-list", "--count", "refs/remotes/origin/fix/cart..HEAD"] });
      expect(mutating(t.calls)).toEqual([]);
    } finally {
      fs.rmSync(wt, { recursive: true, force: true });
    }
    // A worktree just created from a local branch that is ahead says it was created.
    const created = setup({ localBranch: true, ahead: 1 });
    await expect(prepareFixWorktree(created.git, created.project, mrInfo())).rejects.toThrow(`created ${created.wtDir}; fix/cart has local commits not on origin (1 ahead)`);
  });

  test("stops on uncommitted changes", async () => {
    const t = setup({ dirty: true });
    await expect(prepareFixWorktree(t.git, t.project, mrInfo())).rejects.toThrow("uncommitted");
    expect(t.calls).toContainEqual({ cwd: t.wtDir, args: ["status", "--porcelain"] });
    expect(t.calls.some((c) => c.args[0] === "pull")).toBe(false);
    expect(mutating(t.calls)).toEqual([]);
  });

  test("stops when the pull isn't a fast-forward", async () => {
    const t = setup({ pull: fail("fatal: Not possible to fast-forward, aborting.") });
    await expect(prepareFixWorktree(t.git, t.project, mrInfo())).rejects.toThrow("Not possible to fast-forward");
    expect(mutating(t.calls)).toEqual([]);
  });
});
