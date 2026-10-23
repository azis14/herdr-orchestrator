import fs from "node:fs";
import { OrchError } from "./errors";

/** Direct child pids of a process. Throws when they can't be read: "no children" must be a fact, not a guess. */
export type ChildrenRunner = (pid: number) => Promise<number[]>;

/** The two reads `procChildren` needs; injectable so tests never touch /proc. */
export interface ProcIo {
  readdir(dir: string): string[];
  readFile(file: string): string;
}

export function makeProcChildren(io: ProcIo): ChildrenRunner {
  return async (pid) => {
    let tasks: string[];
    try {
      tasks = io.readdir(`/proc/${pid}/task`);
    } catch (e) {
      throw new OrchError(`cannot list threads of pid ${pid}: ${e instanceof Error ? e.message : e}`);
    }
    const out: number[] = [];
    let read = 0;
    for (const t of tasks) {
      try {
        const raw = io.readFile(`/proc/${pid}/task/${t}/children`);
        read++;
        for (const n of raw.split(/\s+/)) if (n) out.push(Number(n));
      } catch {
        // a thread may exit between readdir and read; fine as long as some thread was read
      }
    }
    if (!read) throw new OrchError(`cannot read the children of pid ${pid}`);
    return out;
  };
}

/** Reads /proc/<pid>/task/*\/children (Linux); throws if the pid is gone or the kernel doesn't expose it. */
export const procChildren: ChildrenRunner = makeProcChildren({
  readdir: (d) => fs.readdirSync(d),
  readFile: (f) => fs.readFileSync(f, "utf8"),
});
