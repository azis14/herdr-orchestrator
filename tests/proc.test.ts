import { describe, expect, test } from "bun:test";
import { OrchError } from "../src/errors";
import { makeProcChildren } from "../src/proc";

const io = (files: Record<string, string | Error>, tasks: string[] | Error) => ({
  readdir: (_d: string) => {
    if (tasks instanceof Error) throw tasks;
    return tasks;
  },
  readFile: (f: string) => {
    const v = files[f];
    if (v === undefined || v instanceof Error) throw v ?? new Error("ENOENT");
    return v;
  },
});

describe("procChildren", () => {
  test("collects children across threads", async () => {
    const run = makeProcChildren(io({ "/proc/5/task/5/children": "7 8 ", "/proc/5/task/6/children": "9" }, ["5", "6"]));
    expect(await run(5)).toEqual([7, 8, 9]);
  });

  test("a process with threads and no children is []", async () => {
    expect(await makeProcChildren(io({ "/proc/5/task/5/children": "\n" }, ["5"]))(5)).toEqual([]);
  });

  test("throws when the task dir cannot be read", async () => {
    const e = await makeProcChildren(io({}, new Error("ENOENT")))(5).catch((e) => e);
    expect(e).toBeInstanceOf(OrchError);
  });

  test("throws when no children file could be read", async () => {
    const e = await makeProcChildren(io({}, ["5", "6"]))(5).catch((e) => e);
    expect(e).toBeInstanceOf(OrchError);
    expect(await makeProcChildren(io({}, []))(5).catch((e) => e)).toBeInstanceOf(OrchError);
  });

  test("tolerates one thread vanishing when another was read", async () => {
    const run = makeProcChildren(io({ "/proc/5/task/5/children": "7" }, ["5", "6"]));
    expect(await run(5)).toEqual([7]);
  });
});
