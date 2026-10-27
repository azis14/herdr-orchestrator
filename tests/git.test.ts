import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { OrchError } from "../src/errors";
import { gitRemote, gitRunner, type GitRunner } from "../src/git";

/** `git -c alias.x='!<sh>' x`: runs a shell command through the real runner. */
const viaAlias = (sh: string) => ["-c", `alias.orchtest=!${sh}`, "orchtest"];

describe("gitRunner", () => {
  test("never lets git prompt on the terminal", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "orch-git-"));
    try {
      const r = await gitRunner(dir, viaAlias("printenv GIT_TERMINAL_PROMPT"));
      expect(r.code).toBe(0);
      expect(r.stdout.trim()).toBe("0");
      // The rest of the environment is still there.
      const home = await gitRunner(dir, viaAlias("printenv HOME"));
      expect(home.stdout.trim()).toBe(process.env.HOME ?? "");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a timeout kills git and returns, even while a child still holds its output open", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "orch-git-"));
    try {
      const start = Date.now();
      const r = await gitRunner(dir, viaAlias("sleep 3"), { timeoutMs: 200 });
      expect(Date.now() - start).toBeLessThan(2000);
      expect(r.timedOut).toBe(true);
      expect(r.code).not.toBe(0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("without a timeout, or finishing in time, nothing is marked timed out", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "orch-git-"));
    try {
      const r = await gitRunner(dir, viaAlias("echo hi"), { timeoutMs: 5000 });
      expect(r).toEqual({ code: 0, stdout: "hi\n", stderr: "" });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("gitRemote", () => {
  test("passes a timeout and returns git's result", async () => {
    const seen: unknown[] = [];
    const git: GitRunner = async (_cwd, args, o) => {
      seen.push({ args, o });
      return { code: 0, stdout: "ok", stderr: "" };
    };
    expect(await gitRemote(git, "/r", ["fetch", "origin", "dev"], "origin")).toEqual({ code: 0, stdout: "ok", stderr: "" });
    expect(seen).toEqual([{ args: ["fetch", "origin", "dev"], o: { timeoutMs: 60_000 } }]);
  });

  test("a timed-out call is a clear OrchError naming the remote", async () => {
    const git: GitRunner = async () => ({ code: 124, stdout: "", stderr: "", timedOut: true });
    const p = gitRemote(git, "/r", ["fetch", "origin", "dev"], "origin");
    await expect(p).rejects.toBeInstanceOf(OrchError);
    await expect(gitRemote(git, "/r", ["fetch", "origin", "dev"], "origin")).rejects.toThrow(
      "git fetch origin dev timed out after 60s; check that origin is reachable",
    );
  });

  const lockErr = "error: cannot lock ref 'refs/remotes/origin/dev': Unable to create '/r/.git/refs/remotes/origin/dev.lock': File exists.";
  const scripted = (results: Array<{ code: number; stdout: string; stderr: string; timedOut?: boolean }>) => {
    let calls = 0;
    const git: GitRunner = async () => results[Math.min(calls++, results.length - 1)]!;
    return { git, calls: () => calls };
  };

  test("retries once when another fetch holds a ref lock", async () => {
    const s = scripted([
      { code: 1, stdout: "", stderr: lockErr },
      { code: 0, stdout: "ok", stderr: "" },
    ]);
    const r = await gitRemote(s.git, "/r", ["fetch", "origin", "dev"], "origin", { retryDelayMs: 0 });
    expect(r.code).toBe(0);
    expect(s.calls()).toBe(2);
  });

  test("does not retry other failures", async () => {
    const fail = { code: 128, stdout: "", stderr: "Permission denied (publickey)." };
    const s = scripted([fail, { code: 0, stdout: "ok", stderr: "" }]);
    expect(await gitRemote(s.git, "/r", ["fetch", "origin", "dev"], "origin", { retryDelayMs: 0 })).toEqual(fail);
    expect(s.calls()).toBe(1);
  });

  test("retries at most once", async () => {
    const second = { code: 1, stdout: "", stderr: `${lockErr} (second)` };
    const s = scripted([{ code: 1, stdout: "", stderr: lockErr }, second, { code: 0, stdout: "ok", stderr: "" }]);
    expect(await gitRemote(s.git, "/r", ["fetch", "origin", "dev"], "origin", { retryDelayMs: 0 })).toEqual(second);
    expect(s.calls()).toBe(2);
  });

  test("a timeout still throws without a retry", async () => {
    const s = scripted([{ code: 124, stdout: "", stderr: lockErr, timedOut: true }, { code: 0, stdout: "ok", stderr: "" }]);
    await expect(gitRemote(s.git, "/r", ["fetch", "origin", "dev"], "origin", { retryDelayMs: 0 })).rejects.toBeInstanceOf(OrchError);
    expect(s.calls()).toBe(1);
  });
});
