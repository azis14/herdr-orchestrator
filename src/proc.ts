import fs from "node:fs";

/** Direct child pids of a process. */
export type ChildrenRunner = (pid: number) => Promise<number[]>;

/** Reads /proc/<pid>/task/*\/children (Linux); [] if the pid is gone or the kernel doesn't expose it. */
export const procChildren: ChildrenRunner = async (pid) => {
  let tasks: string[];
  try {
    tasks = fs.readdirSync(`/proc/${pid}/task`);
  } catch {
    return [];
  }
  const out: number[] = [];
  for (const t of tasks) {
    try {
      const raw = fs.readFileSync(`/proc/${pid}/task/${t}/children`, "utf8");
      for (const n of raw.split(/\s+/)) if (n) out.push(Number(n));
    } catch {
      // thread exited between readdir and read
    }
  }
  return out;
};
