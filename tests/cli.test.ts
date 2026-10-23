import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Herdr } from "../src/herdr";
import { main, type Deps } from "../orch";
import { fakeRunner, ok, testRegistry, ws, type FakeHandler } from "./fakes";

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

describe("cli open", () => {
  test("opens with default agent", async () => {
    const { deps, out } = await testDeps();
    expect(await main(["open", "shop-api"], deps)).toBe(0);
    expect(out.join("\n")).toStartWith("opened shop-api-claude-1 (claude) in shop-api");
  });

  test("unknown project returns 1 and lists known projects", async () => {
    const { deps, err } = testDeps();
    expect(await main(["open", "nope"], deps)).toBe(1);
    expect(err.join("\n")).toContain("shop-api");
  });

  test("no subcommand prints usage and returns 2", async () => {
    const { deps, err } = testDeps();
    expect(await main([], deps)).toBe(2);
    expect(err.join("\n")).toContain("usage");
  });
});
