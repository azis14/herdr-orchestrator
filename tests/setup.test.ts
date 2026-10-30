import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { main } from "../orch";
import { AGENT_PRESETS } from "../src/manage";
import { detect, formatDetection } from "../src/setup";
import { testDeps } from "./fakes";

const emptyDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "orch-setup-"));

describe("detect", () => {
  test("fresh machine without a registry or Herdr", () => {
    const d = detect(emptyDir(), (b) => (b === "claude" || b === "git" || b === "bun" ? `/usr/bin/${b}` : null), {});
    expect(d.insideHerdr).toBe(false);
    expect(d.prereqs.find((p) => p.name === "herdr")!.found).toBe(false);
    expect(d.prereqs.find((p) => p.name === "git")).toEqual({ name: "git", found: true, path: "/usr/bin/git" });
    expect(d.agents.map((a) => [a.name, a.bin, a.found, a.registered])).toEqual([
      ["claude", "claude", true, false],
      ["cursor", "cursor-agent", false, false],
      ["omp", "omp", false, false],
    ]);
    expect(d.agents[1].install).toBe(AGENT_PRESETS[1].install);
    expect(d.registry).toEqual({ exists: false, defaultAgent: null, projects: [] });
    const text = formatDetection(d);
    expect(text).toContain("herdr: not found");
    expect(text).toContain(AGENT_PRESETS[1].install);
  });

  test("reports gh and glab as optional tools", () => {
    const d = detect(emptyDir(), (b) => (b === "gh" ? "/usr/bin/gh" : null), {});
    expect(d.optional).toEqual([
      { name: "gh", found: true, path: "/usr/bin/gh" },
      { name: "glab", found: false, path: null },
    ]);
    const text = formatDetection(d);
    expect(text).toContain("Optional (for /mr-review, /mr-fix):");
    expect(text).toContain("glab: not found");
  });

  test("existing registry is reported", () => {
    const dir = emptyDir();
    fs.writeFileSync(
      path.join(dir, "agents.json"),
      JSON.stringify({ defaultAgent: "cursor", agents: AGENT_PRESETS.map((p) => p.def) }),
    );
    fs.writeFileSync(
      path.join(dir, "projects.json"),
      JSON.stringify({ projects: [{ name: "shop-api", path: "/x", description: "d", context: [] }] }),
    );
    const d = detect(dir, (b) => `/usr/bin/${b}`, { HERDR_ENV: "1" });
    expect(d.insideHerdr).toBe(true);
    expect(d.agents.map((a) => [a.registered, a.isDefault])).toEqual([
      [true, false],
      [true, true],
      [true, false],
    ]);
    expect(d.registry).toEqual({ exists: true, defaultAgent: "cursor", projects: ["shop-api"] });
  });
});

describe("cli setup", () => {
  test("setup --json works with no registry", async () => {
    const t = testDeps();
    Object.defineProperty(t.deps, "reg", {
      get: () => {
        throw new Error("reg must not be read");
      },
    });
    expect(await main(["setup", "--json"], t.deps)).toBe(0);
    expect(JSON.parse(t.out.join("\n")).insideHerdr).toBe(true);
    expect(await main(["setup"], t.deps)).toBe(0);
  });
});
