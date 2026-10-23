import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { main } from "../orch";
import { OrchError } from "../src/errors";
import {
  appendLog,
  listJobs,
  loadJob,
  newJob,
  patchAgent,
  setStage,
  upsertAgent,
  type JobAgent,
} from "../src/jobs";
import { testDeps, testRegistry } from "./fakes";

const now = new Date(2026, 9, 23);
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "orch-jobs-"));
const base = { slug: "invoice-export", title: "Invoice export", request: "Export invoices", now };

const agent = (agentName: string, extra: Partial<JobAgent> = {}): JobAgent => ({
  project: "shop-api",
  agent: "claude",
  agentName,
  workspaceId: "w9",
  tabId: "w9:t1",
  paneId: "w9:p1",
  mode: "herdr-worktree",
  status: "started",
  ...extra,
});

describe("jobs", () => {
  test("newJob writes job.json, summary.md and log.md", () => {
    const root = tmp();
    const job = newJob(root, testRegistry(), { ...base, projects: ["shop-api", "shop-ui"] });
    expect(job.id).toBe("20261023-invoice-export");
    expect(job.stage).toBe("design");
    expect(job.agents).toEqual([]);
    const dir = path.join(root, "jobs", job.id);
    expect(JSON.parse(fs.readFileSync(path.join(dir, "job.json"), "utf8")).projects).toEqual(["shop-api", "shop-ui"]);
    const summary = fs.readFileSync(path.join(dir, "summary.md"), "utf8");
    expect(summary).toContain("# Invoice export");
    expect(summary).toContain("## Cross-repo contract");
    expect(summary).toContain("Export invoices");
    expect(fs.existsSync(path.join(dir, "log.md"))).toBe(true);
  });

  test("id collision appends a suffix", () => {
    const root = tmp();
    const reg = testRegistry();
    newJob(root, reg, { ...base, projects: ["shop-api"] });
    expect(newJob(root, reg, { ...base, projects: ["shop-api"] }).id).toBe("20261023-invoice-export-2");
    expect(newJob(root, reg, { ...base, projects: ["shop-api"] }).id).toBe("20261023-invoice-export-3");
  });

  test("rejects bad slug and unknown project", () => {
    const root = tmp();
    const reg = testRegistry();
    expect(() => newJob(root, reg, { ...base, slug: "Bad Slug", projects: ["shop-api"] })).toThrow(OrchError);
    expect(() => newJob(root, reg, { ...base, projects: ["nope"] })).toThrow(OrchError);
    expect(() => newJob(root, reg, { ...base, projects: [] })).toThrow(OrchError);
  });

  test("setStage accepts known stages and rejects unknown", () => {
    const root = tmp();
    const { id } = newJob(root, testRegistry(), { ...base, projects: ["shop-api"] });
    expect(setStage(root, id, "plan").stage).toBe("plan");
    expect(loadJob(root, id).stage).toBe("plan");
    expect(() => setStage(root, id, "shipping" as never)).toThrow(OrchError);
  });

  test("loadJob unknown id throws OrchError", () => {
    expect(() => loadJob(tmp(), "nope")).toThrow(OrchError);
  });

  test("appendLog appends, never overwrites", () => {
    const root = tmp();
    const { id } = newJob(root, testRegistry(), { ...base, projects: ["shop-api"] });
    appendLog(root, id, "first", now);
    appendLog(root, id, "second", now);
    const log = fs.readFileSync(path.join(root, "jobs", id, "log.md"), "utf8");
    expect(log).toContain(`## ${now.toISOString()}\n\nfirst\n\n`);
    expect(log.indexOf("first")).toBeLessThan(log.indexOf("second"));
  });

  test("upsertAgent replaces by agentName; patchAgent rejects unknown agent", () => {
    const root = tmp();
    const { id } = newJob(root, testRegistry(), { ...base, projects: ["shop-api"] });
    upsertAgent(root, id, agent("a1"));
    upsertAgent(root, id, agent("a1", { paneId: "w9:p2" }));
    upsertAgent(root, id, agent("a2"));
    expect(loadJob(root, id).agents.map((a) => [a.agentName, a.paneId])).toEqual([
      ["a1", "w9:p2"],
      ["a2", "w9:p1"],
    ]);
    expect(patchAgent(root, id, "a1", { designPath: "/d.md" }).agents[0].designPath).toBe("/d.md");
    expect(() => patchAgent(root, id, "zz", { status: "x" })).toThrow(OrchError);
  });

  test("listJobs is newest first", () => {
    const root = tmp();
    const reg = testRegistry();
    newJob(root, reg, { ...base, slug: "old", projects: ["shop-api"], now: new Date(2026, 9, 1) });
    newJob(root, reg, { ...base, slug: "new", projects: ["shop-api"], now: new Date(2026, 9, 20) });
    expect(listJobs(root).map((j) => j.id)).toEqual(["20261020-new", "20261001-old"]);
    expect(listJobs(tmp())).toEqual([]);
  });

  test("cli job new, list, stage, show, agent", async () => {
    const { deps, out, err } = testDeps();
    expect(
      await main(["job", "new", "x", "--title", "T", "--request", "R", "--projects", "shop-api,shop-ui"], deps),
    ).toBe(0);
    const id = out.pop()!;
    expect(id).toBe("20261023-x");
    expect(await main(["job", "list"], deps)).toBe(0);
    expect(out.pop()).toContain(id);
    expect(await main(["job", "stage", id, "plan"], deps)).toBe(0);
    expect(await main(["job", "show", id], deps)).toBe(0);
    expect(out.join("\n")).toContain('"stage": "plan"');
    expect(await main(["job", "log", id, "hello"], deps)).toBe(0);
    upsertAgent(deps.root, id, agent("a1"));
    expect(await main(["job", "agent", id, "a1", "designPath=/d.md", "status=designing"], deps)).toBe(0);
    expect(loadJob(deps.root, id).agents[0]).toMatchObject({ designPath: "/d.md", status: "designing" });
    expect(await main(["job", "agent", id, "a1", "foo=1"], deps)).toBe(1);
    expect(err.join("\n")).toContain("foo");
  });
});
