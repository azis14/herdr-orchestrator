import { OrchError } from "./errors";
import type { GitRunner } from "./git";

export type Side = "new" | "old";

export interface DiffPosition {
  kind: "added" | "removed" | "context" | "outside";
  path: string;
  oldPath: string;
  side: Side;
  line?: number;
  oldLine?: number;
}

export interface PositionQuery {
  path: string;
  oldPath?: string;
  line: number;
  side: Side;
}

const HUNK = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

/**
 * Pure: walks a unified diff to find what kind of line `o.line` is. `o.line` is a line of the head file
 * (side new) or of the base file (side old). An added line takes `line`, a removed line takes `oldLine`,
 * a context line takes both, and a line outside every hunk cannot carry an inline thread.
 */
export function positionInDiff(diff: string, o: PositionQuery): DiffPosition {
  const oldPath = o.oldPath || o.path;
  const at = (kind: DiffPosition["kind"], extra: { line?: number; oldLine?: number } = {}): DiffPosition => ({
    kind,
    path: o.path,
    oldPath,
    side: o.side,
    ...extra,
  });

  let oldLn = 0;
  let newLn = 0;
  let inHunk = false;
  for (const raw of diff.split(/\r?\n/)) {
    const m = HUNK.exec(raw);
    if (m) {
      oldLn = Number(m[1]);
      newLn = Number(m[2]);
      inHunk = true;
      continue;
    }
    if (!inHunk || raw.startsWith("\\")) continue;
    const tag = raw.slice(0, 1);
    if (tag === "+") {
      if (o.side === "new" && newLn === o.line) return at("added", { line: newLn });
      newLn++;
    } else if (tag === "-") {
      if (o.side === "old" && oldLn === o.line) return at("removed", { oldLine: oldLn });
      oldLn++;
    } else if (tag === " ") {
      if ((o.side === "new" && newLn === o.line) || (o.side === "old" && oldLn === o.line)) {
        return at("context", { line: newLn, oldLine: oldLn });
      }
      oldLn++;
      newLn++;
    } else {
      // The next file header ("diff --git ..."); only happens with renames.
      inHunk = false;
    }
  }
  return at("outside");
}

/** The unified diff of one file over `base..head` (`oldPath` first when it differs from `path`), for `positionInDiff`. */
export async function fileDiff(git: GitRunner, cwd: string, base: string, head: string, o: { path: string; oldPath?: string }): Promise<string> {
  const oldPath = o.oldPath || o.path;
  const paths = oldPath === o.path ? [o.path] : [oldPath, o.path];
  const args = ["diff", "--no-color", "--no-ext-diff", "-M", "-U3", base, head, "--", ...paths];
  const r = await git(cwd, args);
  if (r.code !== 0) throw new OrchError(`git ${args.join(" ")} failed in ${cwd}: ${r.stderr.trim()}`);
  return r.stdout;
}

/** The position of one line of `base..head`, read from the real diff. */
export async function diffPosition(git: GitRunner, cwd: string, base: string, head: string, o: PositionQuery): Promise<DiffPosition> {
  return positionInDiff(await fileDiff(git, cwd, base, head, o), { ...o, oldPath: o.oldPath || o.path });
}
