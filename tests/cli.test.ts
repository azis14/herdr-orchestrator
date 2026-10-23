import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { main } from "../orch";
import { testDeps } from "./fakes";

describe("cli open", () => {
  test("opens with default agent", async () => {
    const { deps, out } = await testDeps();
    expect(await main(["open", "shop-api"], deps)).toBe(0);
    expect(out.join("\n")).toStartWith("opened claude (claude) in shop-api");
  });

  test("--topic labels the tab", async () => {
    const { deps, run } = testDeps();
    expect(await main(["open", "shop-api", "cursor", "--topic", "login bug"], deps)).toBe(0);
    expect(run.calls.find((c) => c[0] === "tab" && c[1] === "create")).toContain("login bug");
  });

  test("empty --topic or a stray arg is rejected", async () => {
    let t = testDeps();
    expect(await main(["open", "shop-api", "--topic", " "], t.deps)).toBe(1);
    expect(t.err.join("\n")).toContain("--topic");
    t = testDeps();
    expect(await main(["open", "shop-api", "claude", "extra"], t.deps)).toBe(1);
    expect(t.err.join("\n")).toContain("usage");
  });

  test("bash opens a terminal tab with no agent", async () => {
    const { deps, out, run } = testDeps();
    expect(await main(["bash", "shop-api", "--topic", "logs"], deps)).toBe(0);
    expect(out.join("\n")).toStartWith("opened terminal in shop-api");
    expect(run.calls.some((c) => c[0] === "agent" && c[1] === "start")).toBe(false);
  });

  test("bash rejects an agent arg or an empty --topic", async () => {
    let t = testDeps();
    expect(await main(["bash", "shop-api", "claude"], t.deps)).toBe(1);
    expect(t.err.join("\n")).toContain("usage");
    t = testDeps();
    expect(await main(["bash", "shop-api", "--topic", ""], t.deps)).toBe(1);
    expect(t.err.join("\n")).toContain("--topic");
  });

  test("code opens a project's repo, a directory path, or '.'", async () => {
    const opened: string[] = [];
    const { deps, out } = testDeps({}, { editor: async (dir) => (opened.push(dir), { code: 0, stderr: "" }) });
    expect(await main(["code", "shop-api"], deps)).toBe(0);
    expect(out.join("\n")).toStartWith("opened shop-api in VS Code");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "orch-code-"));
    expect(await main(["code", dir], deps)).toBe(0);
    expect(await main(["code", "."], deps)).toBe(0);
    expect(opened).toEqual([deps.reg.projects[0].path, dir, process.cwd()]);
  });

  test("code rejects a target that is neither a project nor a directory", async () => {
    const t = testDeps();
    expect(await main(["code", "nope-not-here"], t.deps)).toBe(1);
    expect(t.err.join("\n")).toContain("shop-api");
  });

  test("code reports a launcher failure, and needs exactly one target", async () => {
    let t = testDeps({}, { editor: async () => ({ code: 127, stderr: "code: not found" }) });
    expect(await main(["code", "shop-api"], t.deps)).toBe(1);
    expect(t.err.join("\n")).toContain("code: not found");
    t = testDeps();
    expect(await main(["code"], t.deps)).toBe(1);
    expect(t.err.join("\n")).toContain("usage");
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

describe("cli project", () => {
  function setup() {
    const t = testDeps();
    fs.mkdirSync(path.join(t.deps.root, "registry"));
    fs.writeFileSync(path.join(t.deps.root, "registry/projects.json"), '{"projects": []}');
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), "orch-repo-"));
    fs.writeFileSync(path.join(repo, "CLAUDE.md"), "");
    return { ...t, repo, file: path.join(t.deps.root, "registry/projects.json") };
  }

  test("project add saves and prints the entry", async () => {
    const { deps, out, repo, file } = setup();
    expect(await main(["project", "add", repo, "--description", "Thing (Go)", "--context", "CLAUDE.md"], deps)).toBe(0);
    const printed = JSON.parse(out.join("\n"));
    expect(printed).toEqual({ name: path.basename(repo), path: repo, description: "Thing (Go)", context: ["CLAUDE.md"] });
    expect(JSON.parse(fs.readFileSync(file, "utf8")).projects).toEqual([printed]);
  });

  test("project add without --context saves an empty context list", async () => {
    const { deps, out, repo } = setup();
    expect(await main(["project", "add", repo, "--description", "Thing"], deps)).toBe(0);
    expect(JSON.parse(out.join("\n")).context).toEqual([]);
  });

  test("project add without --description returns 1", async () => {
    const { deps, err, repo } = setup();
    expect(await main(["project", "add", repo], deps)).toBe(1);
    expect(err.join("\n")).toContain("--description");
  });

  test("project add with more than one path returns 1 and writes nothing", async () => {
    const { deps, err, repo, file } = setup();
    expect(await main(["project", "add", repo, "extra", "--description", "x"], deps)).toBe(1);
    expect(err.join("\n")).toContain("project add");
    expect(JSON.parse(fs.readFileSync(file, "utf8")).projects).toEqual([]);
  });

  test("project add duplicate name returns 1 with the message", async () => {
    const { deps, err, repo } = setup();
    expect(await main(["project", "add", repo, "--name", "shop-api", "--description", "x"], deps)).toBe(1);
    expect(err.join("\n")).toContain("already registered");
  });

  test("project with no or unknown subcommand returns 1 with usage", async () => {
    for (const argv of [["project"], ["project", "rm"]]) {
      const { deps, err } = setup();
      expect(await main(argv, deps)).toBe(1);
      expect(err.join("\n")).toContain("project add");
    }
  });
});
