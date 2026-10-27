import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Deps } from "../orch";
import type { ForgeBin, ForgeRunner } from "../src/forge";
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

export interface FakeForge extends ForgeRunner {
  calls: { bin: ForgeBin; args: string[]; stdin?: string }[];
}

/**
 * A ForgeRunner keyed on "<METHOD> <path without query>" for `api` calls and on
 * "graphql <first word after query/mutation>" for GraphQL; throws on unhandled calls.
 */
export function fakeForge(handlers: Record<string, (args: string[], stdin?: string) => FakeReply>): FakeForge {
  const calls: FakeForge["calls"] = [];
  const run = (async (bin: ForgeBin, args: string[], stdin?: string) => {
    calls.push({ bin, args, stdin });
    let key: string;
    if (args[1] === "graphql") {
      const query: string = JSON.parse(stdin ?? "{}").query ?? "";
      key = `graphql ${query.match(/\b(?:query|mutation)\b\s*\{?\s*(\w+)/)?.[1] ?? ""}`;
    } else {
      const m = args.indexOf("--method");
      key = `${args[m + 1]} ${args[m + 2].split("?")[0]}`;
    }
    const h = handlers[key];
    if (!h) throw new Error(`fakeForge: unhandled call: ${bin} ${args.join(" ")}`);
    const r = h(args, stdin);
    return { code: r.code ?? 0, stdout: text(r.stdout), stderr: text(r.stderr) };
  }) as FakeForge;
  run.calls = calls;
  return run;
}

/** A registry whose projects point at fresh temp dirs (so getProject's existence check passes). */
export function testRegistry(names: string[] = ["shop-api", "shop-ui"]): Registry {
  return {
    defaultAgent: "claude",
    agents: [
      { name: "claude", kind: "claude", openArgs: [], jobArgs: [], resumeArgs: ["--resume", "{session}"] },
      { name: "cursor", kind: "cursor", openArgs: [], jobArgs: ["--force"], worktreeArgs: ["--trust"], resumeArgs: ["--resume", "{session}"] },
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
    editor: async () => ({ code: 0, stderr: "" }),
    claudeProjects: fs.mkdtempSync(path.join(os.tmpdir(), "orch-claude-")),
    cursorChats: fs.mkdtempSync(path.join(os.tmpdir(), "orch-cursor-")),
    children: async () => [],
    forge: fakeForge({}),
    readStdin: async () => "",
    which: (bin) => `/usr/bin/${bin}`,
    env: { HERDR_ENV: "1" },
    out: (s) => out.push(s),
    err: (s) => err.push(s),
    now: () => new Date(2026, 9, 23),
    ...overrides,
  };
  return { deps, out, err, run };
}
