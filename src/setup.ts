import fs from "node:fs";
import path from "node:path";
import { AGENT_PRESETS } from "./manage";
import { readJson } from "./registry";

export interface Detection {
  prereqs: { name: "bun" | "herdr" | "git"; found: boolean; path: string | null }[];
  insideHerdr: boolean;
  agents: { name: string; bin: string; install: string; found: boolean; registered: boolean; isDefault: boolean }[];
  /** `exists` means both registry files are present. */
  registry: { exists: boolean; defaultAgent: string | null; projects: string[] };
}

/** What `/setup` needs to know: prerequisites, whether we're in Herdr, installed agents and the current registry. Never needs a registry. */
export function detect(
  dir: string,
  which: (bin: string) => string | null,
  env: Record<string, string | undefined>,
): Detection {
  const agentsFile = path.join(dir, "agents.json");
  const projectsFile = path.join(dir, "projects.json");
  const agents = fs.existsSync(agentsFile) ? readJson(agentsFile) : undefined;
  const projects = fs.existsSync(projectsFile) ? readJson(projectsFile) : undefined;
  const registered = new Set<string>((agents?.agents ?? []).map((a: { name: string }) => a.name));
  const defaultAgent: string | null = agents?.defaultAgent ?? null;
  return {
    prereqs: (["bun", "herdr", "git"] as const).map((name) => {
      const p = which(name);
      return { name, found: p !== null, path: p };
    }),
    insideHerdr: env.HERDR_ENV === "1",
    agents: AGENT_PRESETS.map((p) => ({
      name: p.def.name,
      bin: p.bin,
      install: p.install,
      found: which(p.bin) !== null,
      registered: registered.has(p.def.name),
      isDefault: defaultAgent === p.def.name,
    })),
    registry: {
      exists: agents !== undefined && projects !== undefined,
      defaultAgent,
      projects: (projects?.projects ?? []).map((p: { name: string }) => p.name),
    },
  };
}

export function formatDetection(d: Detection): string {
  const lines = ["Prerequisites:"];
  for (const p of d.prereqs) lines.push(`  ${p.name}: ${p.found ? p.path : "not found"}`);
  lines.push(`  inside Herdr: ${d.insideHerdr ? "yes" : "no (run this from a Herdr pane)"}`);
  lines.push("Agents:");
  for (const a of d.agents) {
    const state = [a.found ? "installed" : `not found (install: ${a.install})`];
    if (a.registered) state.push(a.isDefault ? "registered, default" : "registered");
    lines.push(`  ${a.name} (${a.bin}): ${state.join(", ")}`);
  }
  lines.push(`Registry: ${d.registry.exists ? `${d.registry.projects.length} projects` : "not set up yet"}`);
  for (const p of d.registry.projects) lines.push(`  ${p}`);
  return lines.join("\n");
}
