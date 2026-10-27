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

  test("every subagent_type named in commands, agents and skills has an agent file", () => {
    const files = [
      ...fs.readdirSync(path.join(ORCH_ROOT, ".claude/commands")).map((f) => path.join(".claude/commands", f)),
      ...fs.readdirSync(path.join(ORCH_ROOT, ".claude/agents")).map((f) => path.join(".claude/agents", f)),
      ...fs
        .readdirSync(path.join(ORCH_ROOT, ".agents/skills"))
        .map((d) => path.join(".agents/skills", d, "SKILL.md"))
        .filter((f) => fs.existsSync(path.join(ORCH_ROOT, f))),
    ].filter((f) => f.endsWith(".md"));
    const named = new Set<string>();
    for (const f of files) {
      for (const m of fs.readFileSync(path.join(ORCH_ROOT, f), "utf8").matchAll(/subagent_type:\s*"([a-z0-9-]+)"/g)) {
        if (m[1] !== "general-purpose") named.add(m[1]);
      }
    }
    expect([...named]).toEqual(expect.arrayContaining(["mr-review-runner", "mr-reviewer", "mr-verifier"]));
    const missing = [...named].filter((n) => !fs.existsSync(path.join(ORCH_ROOT, ".claude/agents", `${n}.md`)));
    expect(missing).toEqual([]);
  });

  test("settings.json allows exactly the review's calls", () => {
    const settings = JSON.parse(fs.readFileSync(path.join(ORCH_ROOT, ".claude/settings.json"), "utf8"));
    expect(new Set(settings.permissions.allow)).toEqual(
      new Set([
        "Bash(bun orch.ts mr show:*)",
        "Bash(bun orch.ts mr threads:*)",
        "Bash(bun orch.ts mr position:*)",
        "Bash(bun orch.ts mr post:*)",
        "Bash(bun orch.ts skills:*)",
        "Bash(git -C * show *)",
        "Bash(git -C * ls-tree *)",
        "Bash(git -C * diff *)",
        "Bash(git -C * log *)",
        "Bash(git -C * blame *)",
        "Bash(git -C * worktree add --detach */mr-*/wt *)",
        "Bash(git -C * worktree remove --force */mr-*/wt)",
        "Bash(mktemp -d *)",
      ]),
    );
    expect(settings.permissions.allow.length).toBe(13);
  });
});
