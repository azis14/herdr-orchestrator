import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { main } from "../orch";
import { OrchError } from "../src/errors";
import { ORCH_ROOT } from "../src/registry";
import { projectSkills, resolveSkill, scanSkills } from "../src/skills";
import { testDeps, testRegistry } from "./fakes";

function addSkill(root: string, dir: string, name: string) {
  const d = path.join(root, dir, name);
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, "SKILL.md"), `---\nname: ${name}\n---\n`);
}

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "orch-skills-"));

describe("skills", () => {
  test("scan dedupes by name and skips missing dirs and non-skills", () => {
    const root = tmp();
    addSkill(root, ".claude/skills", "a");
    addSkill(root, ".agents/skills", "a");
    addSkill(root, ".agents/skills", "b");
    fs.mkdirSync(path.join(root, ".agents/skills/not-a-skill"), { recursive: true });
    const found = scanSkills(root);
    expect(found.map((s) => s.name)).toEqual(["a", "b"]);
    expect(found[0].path).toBe(path.join(root, ".claude/skills/a/SKILL.md"));
  });

  test("scan follows symlinks", () => {
    const root = tmp();
    addSkill(root, ".agents/skills", "x");
    fs.mkdirSync(path.join(root, ".claude/skills"), { recursive: true });
    fs.symlinkSync("../../.agents/skills/x", path.join(root, ".claude/skills/x"));
    expect(scanSkills(root)).toEqual([{ name: "x", path: path.join(root, ".claude/skills/x/SKILL.md") }]);
  });

  test("scan of a dir with no skill dirs is empty", () => {
    expect(scanSkills(tmp())).toEqual([]);
  });

  test("alsoInOrchestrator lists repo skills the orchestrator also has", () => {
    const reg = testRegistry(["shop-api"]);
    const repo = reg.projects[0].path;
    const orch = tmp();
    addSkill(repo, ".claude/skills", "brainstorming");
    addSkill(repo, ".claude/skills", "audit-trail-logging");
    addSkill(orch, ".agents/skills", "brainstorming");
    const ps = projectSkills(reg, "shop-api", orch);
    expect(ps.repoSkills.map((s) => s.name)).toEqual(["audit-trail-logging", "brainstorming"]);
    expect(ps.alsoInOrchestrator).toEqual(["brainstorming"]);
  });

  test("resolve prefers repo, falls back to orchestrator, throws on neither", () => {
    const reg = testRegistry(["shop-api", "shop-ui"]);
    const [api, ui] = reg.projects.map((p) => p.path);
    const orch = tmp();
    addSkill(api, ".claude/skills", "brainstorming");
    addSkill(orch, ".agents/skills", "brainstorming");
    expect(resolveSkill(reg, "shop-api", "brainstorming", orch)).toEqual({
      source: "repo",
      path: path.join(api, ".claude/skills/brainstorming/SKILL.md"),
    });
    expect(resolveSkill(reg, "shop-ui", "brainstorming", orch)).toEqual({
      source: "orchestrator",
      path: path.join(orch, ".agents/skills/brainstorming/SKILL.md"),
    });
    expect(() => resolveSkill(reg, "shop-ui", "nope", orch)).toThrow(OrchError);
    expect(ui).toBeTruthy();
  });

  test("cli skills --resolve prints source and path", async () => {
    const { deps, out } = testDeps();
    addSkill(deps.reg.projects[0].path, ".claude/skills", "brainstorming");
    expect(await main(["skills", "shop-api", "--resolve", "brainstorming"], deps)).toBe(0);
    expect(out.join("\n")).toBe(`repo ${path.join(deps.reg.projects[0].path, ".claude/skills/brainstorming/SKILL.md")}`);
  });

  test("cli skills <project> --json prints the structure", async () => {
    const { deps, out } = testDeps();
    addSkill(deps.reg.projects[0].path, ".agents/skills", "x");
    expect(await main(["skills", "shop-api", "--json"], deps)).toBe(0);
    const parsed = JSON.parse(out.join("\n"));
    expect(parsed.project).toBe("shop-api");
    expect(parsed.repoSkills[0].name).toBe("x");
  });

  test("orchestrator ships the review skills but no skill named like a command", () => {
    const names = scanSkills(ORCH_ROOT).map((s) => s.name);
    expect(names).toEqual(expect.arrayContaining(["reviewing-mrs", "mr-comments", "mr-fix"]));
    const commands = fs.readdirSync(path.join(ORCH_ROOT, ".claude/commands")).map((f) => f.replace(/\.md$/, ""));
    const clashes = fs.readdirSync(path.join(ORCH_ROOT, ".claude/skills")).filter((s) => commands.includes(s));
    expect(clashes).toEqual([]);
  });
});
