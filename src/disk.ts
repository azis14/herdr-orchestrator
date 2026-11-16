/** Bytes a folder holds that deleting it would free, or null when that can't be measured. */
export type SizeRunner = (dir: string) => Promise<number | null>;

/** How long sizing one folder may take before it is given up on. */
export const SIZE_TIMEOUT_MS = 120_000;

/**
 * The total size of the regular files under `dir` whose hard-link count is 1. Files with more links
 * (pnpm hard-links node_modules into a shared store) stay on disk when the folder goes, so they aren't counted.
 * Null on a timeout, a nonzero exit, or a failed spawn.
 */
export const uniqueBytes: SizeRunner = async (dir) => {
  try {
    const proc = Bun.spawn(["find", dir, "-xdev", "-type", "f", "-links", "1", "-printf", "%s\\n"], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "ignore",
    });
    const done = Promise.all([new Response(proc.stdout).text(), proc.exited]).then(
      ([stdout, code]): number | null => {
        if (code !== 0) return null;
        return stdout.split("\n").reduce((sum, line) => sum + (Number(line) || 0), 0);
      },
    );
    let timer: ReturnType<typeof setTimeout> | undefined;
    // Don't wait for the pipe after a kill.
    const timeout = new Promise<null>((resolve) => {
      timer = setTimeout(() => {
        proc.kill("SIGKILL");
        done.catch(() => {});
        resolve(null);
      }, SIZE_TIMEOUT_MS);
    });
    try {
      return await Promise.race([done, timeout]);
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return null;
  }
};

/** A size for people: `1.2 GB`, `477 MB`, `12 KB` (base 1024). */
export function formatBytes(n: number): string {
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(1)} GB`;
  if (n >= 1024 ** 2) return `${Math.round(n / 1024 ** 2)} MB`;
  return `${Math.round(n / 1024)} KB`;
}
