import { OrchError } from "./errors";

export interface GitOptions {
  /** Kill git after this many milliseconds and return `timedOut: true`. */
  timeoutMs?: number;
}

export interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
  /** Set when `timeoutMs` ran out and git was killed. */
  timedOut?: boolean;
}

export type GitRunner = (cwd: string, args: string[], o?: GitOptions) => Promise<GitResult>;

export const gitRunner: GitRunner = async (cwd, args, o = {}) => {
  const proc = Bun.spawn(["git", "-C", cwd, ...args], {
    // Never wait on a username/password prompt nobody will answer.
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const done = Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]).then(
    ([stdout, stderr, code]): GitResult => ({ code, stdout, stderr }),
  );
  if (!o.timeoutMs) return done;
  let timer: ReturnType<typeof setTimeout> | undefined;
  // Don't wait for the pipes after a kill: a child git started (ssh) can keep them open.
  const timeout = new Promise<GitResult>((resolve) => {
    timer = setTimeout(() => {
      proc.kill("SIGKILL");
      done.catch(() => {});
      resolve({ code: 124, stdout: "", stderr: `timed out after ${o.timeoutMs}ms`, timedOut: true });
    }, o.timeoutMs);
  });
  try {
    return await Promise.race([done, timeout]);
  } finally {
    clearTimeout(timer);
  }
};

/** How long a fetch or pull may take before orch gives up on the remote. */
export const REMOTE_TIMEOUT_MS = 60_000;

/** A git call that talks to `remote` (fetch, pull), killed after REMOTE_TIMEOUT_MS so an unreachable remote can't hang orch. */
export async function gitRemote(git: GitRunner, cwd: string, args: string[], remote: string): Promise<GitResult> {
  const r = await git(cwd, args, { timeoutMs: REMOTE_TIMEOUT_MS });
  if (r.timedOut) {
    throw new OrchError(`git ${args.join(" ")} timed out after ${REMOTE_TIMEOUT_MS / 1000}s; check that ${remote} is reachable`);
  }
  return r;
}
