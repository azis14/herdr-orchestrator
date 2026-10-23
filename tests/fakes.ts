import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Deps } from "../orch";
import { Herdr, type Runner } from "../src/herdr";
import type { Registry } from "../src/registry";

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

/** A registry whose projects point at fresh temp dirs (so getProject's existence check passes). */
export function testRegistry(names: string[] = ["shop-api", "shop-ui"]): Registry {
  return {
    defaultAgent: "claude",
    agents: [
      { name: "claude", kind: "claude", openArgs: [], jobArgs: [] },
      { name: "cursor", kind: "cursor", openArgs: [], jobArgs: ["--force"] },
    ],
    projects: names.map((name) => ({
      name,
      path: fs.mkdtempSync(path.join(os.tmpdir(), `orch-${name}-`)),
      description: name,
      context: [],
    })),
  };
}

export const ok = (result: unknown): FakeReply => ({ stdout: { id: "cli:x", result } });

export const ws = (workspace_id: string, label: string, number: number, focused = false) => ({
  workspace_id,
  label,
  number,
  focused,
});

export function testDeps(handlers: Record<string, FakeHandler> = {}, overrides: Partial<Deps> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const run = fakeRunner({
    "workspace list": () => ok({ workspaces: [ws("w5", "shop-api", 2)] }),
    "agent list": () => ok({ agents: [] }),
    "tab create": (a) => ok({ tab: { tab_id: `${a[3]}:t9` }, root_pane: { pane_id: `${a[3]}:p9` } }),
    "agent start": () => ok({}),
    ...handlers,
  });
  const deps: Deps = {
    herdr: new Herdr(run),
    reg: testRegistry(),
    root: fs.mkdtempSync(path.join(os.tmpdir(), "orch-root-")),
    git: async () => ({ code: 0, stdout: "", stderr: "" }),
    out: (s) => out.push(s),
    err: (s) => err.push(s),
    now: () => new Date(2026, 9, 23),
    ...overrides,
  };
  return { deps, out, err, run };
}
