import fs from "node:fs";
import path from "node:path";
import { OrchError } from "./errors";
import { getProject, ORCH_ROOT, type Registry } from "./registry";

/** Where skills live in a repo, in priority order. */
export const SKILL_DIRS = [".claude/skills", ".agents/skills", ".cursor/skills"];

export interface SkillEntry {
  name: string;
  /** Absolute path to the skill's SKILL.md. */
  path: string;
}

export interface ProjectSkills {
  project: string;
  repoSkills: SkillEntry[];
  /** Repo skills the orchestrator also has its own copy of. */
  alsoInOrchestrator: string[];
}

/** Skills under `root`: subdirs (symlinks followed) containing SKILL.md, first SKILL_DIRS hit wins. */
export function scanSkills(root: string): SkillEntry[] {
  const found = new Map<string, SkillEntry>();
  for (const dir of SKILL_DIRS) {
    const base = path.join(root, dir);
    let names: string[];
    try {
      names = fs.readdirSync(base);
    } catch {
      continue;
    }
    for (const name of names) {
      const skillMd = path.join(base, name, "SKILL.md");
      if (!found.has(name) && fs.existsSync(skillMd)) found.set(name, { name, path: skillMd });
    }
  }
  return [...found.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function projectSkills(reg: Registry, project: string, orchRoot = ORCH_ROOT): ProjectSkills {
  const p = getProject(reg, project);
  const repoSkills = scanSkills(p.path);
  const orch = new Set(scanSkills(orchRoot).map((s) => s.name));
  return { project: p.name, repoSkills, alsoInOrchestrator: repoSkills.map((s) => s.name).filter((n) => orch.has(n)) };
}

/** Which copy of `skill` an agent in `project` should use: the repo's own, else the orchestrator's. */
export function resolveSkill(
  reg: Registry,
  project: string,
  skill: string,
  orchRoot = ORCH_ROOT,
): { source: "repo" | "orchestrator"; path: string } {
  const repo = scanSkills(getProject(reg, project).path).find((s) => s.name === skill);
  if (repo) return { source: "repo", path: repo.path };
  const orch = scanSkills(orchRoot).find((s) => s.name === skill);
  if (orch) return { source: "orchestrator", path: orch.path };
  throw new OrchError(`skill "${skill}" not found in ${project} or the orchestrator`);
}
