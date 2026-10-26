import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { main } from "../orch";
import { OrchError } from "../src/errors";
import { saveJob, type Job, type Stage } from "../src/jobs";
import { addAgent, AGENT_PRESETS, formatAgentsJson, removeAgent, removeProject, setDefaultAgent } from "../src/manage";
import { formatProjectsJson, ORCH_ROOT } from "../src/registry";
import { testDeps } from "./fakes";

const [CLAUDE, CURSOR] = AGENT_PRESETS.map((p) => p.def);

const tmp = (prefix: string) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));
const read = (dir: string, f: string) => fs.readFileSync(path.join(dir, f), "utf8");

/** A registry dir; `undefined` leaves that file out. */
function regDir(agents?: unknown, projects?: unknown): string {
  const dir = tmp("orch-manage-");
  if (agents !== undefined) fs.writeFileSync(path.join(dir, "agents.json"), typeof agents === "string" ? agents : JSON.stringify(agents));
  if (projects !== undefined) fs.writeFileSync(path.join(dir, "projects.json"), JSON.stringify(projects));
  return dir;
}

/** An orchestrator root holding these jobs. */
function jobsRoot(jobs: Job[] = []): string {
  const root = tmp("orch-jobs-");
  for (const j of jobs) {
    fs.mkdirSync(path.join(root, "jobs", j.id), { recursive: true });
    saveJob(root, j);
  }
  return root;
}

function job(id: string, stage: Stage, o: { projects?: string[]; agent?: string } = {}): Job {
  const projects = o.projects ?? ["shop-api"];
  return {
    id,
    title: "T",
    request: "R",
    projects,
    stage,
    createdAt: "2026-10-23T00:00:00.000Z",
    agents: o.agent
      ? [{ project: projects[0], agent: o.agent, agentName: "a", workspaceId: "w1", tabId: "w1:t1", paneId: "w1:p1", mode: "herdr-worktree", status: "stopped" }]
      : [],
  };
}

const both = { defaultAgent: "claude", agents: [CLAUDE, CURSOR] };

describe("addAgent", () => {
  test("add to an empty dir creates both files with it as default", () => {
    const dir = regDir();
    addAgent(dir, "cursor");
    expect(JSON.parse(read(dir, "agents.json"))).toEqual({ defaultAgent: "cursor", agents: [CURSOR] });
    expect(JSON.parse(read(dir, "projects.json"))).toEqual({ projects: [] });
  });

  test("add keeps existing agents and creates only a missing projects.json", () => {
    const dir = regDir({ defaultAgent: "claude", agents: [CLAUDE] });
    expect(addAgent(dir, "cursor")).toEqual(CURSOR);
    expect(JSON.parse(read(dir, "agents.json"))).toEqual(both);
    expect(JSON.parse(read(dir, "projects.json"))).toEqual({ projects: [] });
  });

  test("add leaves an existing projects.json alone", () => {
    const projects = { projects: [{ name: "shop-api", path: "/x", description: "d", context: [] }] };
    const dir = regDir(undefined, projects);
    addAgent(dir, "claude");
    expect(JSON.parse(read(dir, "projects.json"))).toEqual(projects);
  });

  test("add repairs a missing or stale default", () => {
    for (const before of [{}, { agents: [] }, { defaultAgent: "cursor", agents: [] }]) {
      const dir = regDir(before, { projects: [] });
      addAgent(dir, "claude");
      expect(JSON.parse(read(dir, "agents.json"))).toEqual({ defaultAgent: "claude", agents: [CLAUDE] });
    }
  });

  test("agents.json that isn't an object with an agents list is an OrchError", () => {
    for (const bad of ["null", "[]", '{"agents": {}}']) {
      const dir = regDir(bad, { projects: [] });
      expect(() => addAgent(dir, "claude")).toThrow(OrchError);
      expect(read(dir, "agents.json")).toBe(bad);
    }
  });

  test("add rejects unknown and duplicate agents", () => {
    const dir = regDir({ defaultAgent: "claude", agents: [CLAUDE] }, { projects: [] });
    expect(() => addAgent(dir, "codex")).toThrow("claude, cursor");
    expect(() => addAgent(dir, "claude")).toThrow("already registered");
  });
});

describe("agent changes", () => {
  test("malformed agents.json is left untouched", () => {
    const dir = regDir("{not json", { projects: [] });
    const root = jobsRoot();
    for (const f of [() => addAgent(dir, "cursor"), () => setDefaultAgent(dir, "claude"), () => removeAgent(dir, root, "claude")]) {
      expect(f).toThrow(OrchError);
      expect(read(dir, "agents.json")).toBe("{not json");
    }
  });

  test("default must be registered", () => {
    const dir = regDir({ defaultAgent: "claude", agents: [CLAUDE] }, { projects: [] });
    expect(() => setDefaultAgent(dir, "cursor")).toThrow("not registered");
    addAgent(dir, "cursor");
    setDefaultAgent(dir, "cursor");
    expect(JSON.parse(read(dir, "agents.json")).defaultAgent).toBe("cursor");
  });

  test("remove refuses the default, including the only agent", () => {
    const dir = regDir({ defaultAgent: "claude", agents: [CLAUDE] }, { projects: [] });
    expect(() => removeAgent(dir, jobsRoot(), "claude")).toThrow("default");
    expect(JSON.parse(read(dir, "agents.json")).agents).toEqual([CLAUDE]);
  });

  test("remove refuses an unknown agent", () => {
    const dir = regDir(both, { projects: [] });
    expect(() => removeAgent(dir, jobsRoot(), "codex")).toThrow("not registered");
  });

  test("remove refuses an agent a project pins", () => {
    const dir = regDir(both, { projects: [{ name: "shop-api", path: "/x", description: "d", context: [], defaultAgent: "cursor" }] });
    expect(() => removeAgent(dir, jobsRoot(), "cursor")).toThrow("shop-api");
  });

  test("remove refuses while an unfinished job uses it, not a done one", () => {
    const dir = regDir(both, { projects: [] });
    const busy = jobsRoot([job("20261023-busy", "build", { agent: "cursor" })]);
    expect(() => removeAgent(dir, busy, "cursor")).toThrow("20261023-busy");
    expect(() => removeAgent(dir, busy, "cursor")).toThrow("bun orch.ts job stage 20261023-busy done");
    removeAgent(dir, jobsRoot([job("20261023-old", "done", { agent: "cursor" })]), "cursor");
    expect(JSON.parse(read(dir, "agents.json"))).toEqual({ defaultAgent: "claude", agents: [CLAUDE] });
  });

  test("agents-example.json is the presets in file style", () => {
    const text = fs.readFileSync(path.join(ORCH_ROOT, "registry/agents-example.json"), "utf8");
    expect(JSON.parse(text)).toEqual({ defaultAgent: "claude", agents: AGENT_PRESETS.map((p) => p.def) });
    expect(formatAgentsJson(JSON.parse(text))).toBe(text);
  });
});

describe("cli agent", () => {
  test("agent add/default/remove", async () => {
    const t = testDeps();
    Object.defineProperty(t.deps, "reg", {
      get: () => {
        throw new Error("reg must not be read");
      },
    });
    expect(await main(["agent", "add", "claude"], t.deps)).toBe(0);
    expect(await main(["agent", "add", "cursor"], t.deps)).toBe(0);
    expect(JSON.parse(t.out[1])).toEqual(CURSOR);
    expect(await main(["agent", "default", "cursor"], t.deps)).toBe(0);
    expect(t.out.at(-1)).toBe("default agent: cursor");
    expect(await main(["agent", "remove", "claude"], t.deps)).toBe(0);
    expect(t.out.at(-1)).toBe("removed agent claude");
    expect(await main(["agent", "bogus"], t.deps)).toBe(1);
    expect(t.err.at(-1)).toContain("usage: agent add <claude|cursor>");
  });
});

describe("removeProject", () => {
  function setup() {
    const api = tmp("orch-shop-api-");
    const projects = {
      projects: [
        { name: "shop-api", path: api, description: "API", context: ["CLAUDE.md"] },
        { name: "shop-ui", path: "/home/user/repos/shop-ui", description: "UI", context: [] },
      ],
    };
    const dir = regDir(both);
    fs.writeFileSync(path.join(dir, "projects.json"), formatProjectsJson(projects));
    return { dir, api };
  }

  test("removeProject drops only that entry and leaves the repo", () => {
    const { dir, api } = setup();
    expect(removeProject(dir, jobsRoot(), "shop-api").path).toBe(api);
    const text = read(dir, "projects.json");
    expect(JSON.parse(text).projects.map((p: { name: string }) => p.name)).toEqual(["shop-ui"]);
    expect(formatProjectsJson(JSON.parse(text))).toBe(text);
    expect(fs.existsSync(api)).toBe(true);
  });

  test("removeProject unknown name lists known names", () => {
    const { dir } = setup();
    expect(() => removeProject(dir, jobsRoot(), "nope")).toThrow("shop-api, shop-ui");
  });

  test("removeProject refuses while an unfinished job includes it", () => {
    const { dir } = setup();
    const before = read(dir, "projects.json");
    const root = jobsRoot([job("20261023-plan", "plan", { projects: ["shop-ui", "shop-api"] })]);
    expect(() => removeProject(dir, root, "shop-api")).toThrow("20261023-plan");
    expect(read(dir, "projects.json")).toBe(before);
    removeProject(dir, jobsRoot([job("20261023-old", "done", { projects: ["shop-api"] })]), "shop-api");
  });

  test("cli: project remove", async () => {
    const t = testDeps();
    const { dir, api } = setup();
    fs.cpSync(dir, path.join(t.deps.root, "registry"), { recursive: true });
    expect(await main(["project", "remove", "shop-api"], t.deps)).toBe(0);
    expect(t.out.at(-1)).toBe(`removed project shop-api (${api})`);
    expect(await main(["project", "remove"], t.deps)).toBe(1);
  });
});
