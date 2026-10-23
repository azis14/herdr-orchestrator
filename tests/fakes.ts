import type { Runner } from "../src/herdr";

export type FakeReply = { code?: number; stdout?: unknown; stderr?: unknown };
export type FakeHandler = (args: string[]) => FakeReply;

export interface FakeRunner extends Runner {
  calls: string[][];
}

const text = (v: unknown) => (v === undefined ? "" : typeof v === "string" ? v : JSON.stringify(v));

/** A Runner keyed on the first two args (e.g. "tab create"); throws on unhandled calls. */
export function fakeRunner(handlers: Record<string, FakeHandler>): FakeRunner {
  const calls: string[][] = [];
  const run = (async (args: string[]) => {
    calls.push(args);
    const key = args.slice(0, 2).join(" ");
    const h = handlers[key];
    if (!h) throw new Error(`fakeRunner: unhandled call: ${args.join(" ")}`);
    const r = h(args);
    return { code: r.code ?? 0, stdout: text(r.stdout), stderr: text(r.stderr) };
  }) as FakeRunner;
  run.calls = calls;
  return run;
}
