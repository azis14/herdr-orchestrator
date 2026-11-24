import fs from "node:fs";
import path from "node:path";
import { OrchError } from "./errors";

/** Bytes of instructions kept from a context file; the rest is cut, so the review brief stays small. */
export const MAX_INSTRUCTIONS = 64 * 1024;

const MR_REVIEW_KEYS = ["skill", "mode", "model", "checks"];
/** Recognised so later versions don't break files; ignored for now. */
const RESERVED = ["model", "checks"];

export interface ProjectContext {
  present: boolean;
  /** The context file, `<registry>/projects/<name>.md`. */
  path: string;
  mrReview: { skill?: string; mode?: "read-only" };
  /** The body's `## mr-review` section, else the whole body. */
  instructions: string;
  warnings: string[];
}

/**
 * Reads a project's local notes file. Never throws on a bad file: a missing one is
 * `present: false`, and anything malformed is dropped with a warning, so it can't block a review.
 */
export function loadProjectContext(dir: string, name: string): ProjectContext {
  if (!/^[^\s,/\\]+$/.test(name) || name === "." || name === "..") {
    throw new OrchError(`invalid project name "${name}"`);
  }
  const projectsDir = path.join(dir, "projects");
  const file = path.join(projectsDir, `${name}.md`);
  const rel = `registry/projects/${name}.md`;
  const ctx: ProjectContext = { present: false, path: file, mrReview: {}, instructions: "", warnings: [] };
  if (!fs.existsSync(file)) return ctx;

  let text: string;
  try {
    const real = fs.realpathSync(file);
    if (path.dirname(real) !== fs.realpathSync(projectsDir)) {
      ctx.warnings.push(`ignored ${rel}: it links outside registry/projects/`);
      return ctx;
    }
    text = fs.readFileSync(real, "utf8").replace(/\r\n/g, "\n");
  } catch (e) {
    ctx.warnings.push(`cannot read ${rel}: ${(e as Error).message}`);
    return ctx;
  }
  ctx.present = true;

  let body = text;
  let front: unknown = {};
  const m = text.match(/^---\n([\s\S]*?)\n?^---[ \t]*(?:\n|$)/m);
  if (text.startsWith("---\n") && m && m.index === 0) {
    body = text.slice(m[0].length);
    try {
      front = Bun.YAML.parse(m[1]) ?? {};
    } catch (e) {
      ctx.warnings.push(`invalid frontmatter in ${rel}: ${(e as Error).message}`);
      front = {};
    }
  } else if (text.startsWith("---\n")) {
    ctx.warnings.push(`invalid frontmatter in ${rel}: no closing ---`);
  }
  if (typeof front !== "object" || Array.isArray(front)) {
    ctx.warnings.push(`invalid frontmatter in ${rel}: not a mapping`);
    front = {};
  }
  readMrReview(front as Record<string, unknown>, rel, ctx);

  const section = body.match(/^## mr-review[ \t]*\n([\s\S]*?)(?=^## |(?![\s\S]))/im);
  let instructions = (section ? section[1] : body).trim();
  if (Buffer.byteLength(instructions) > MAX_INSTRUCTIONS) {
    instructions = Buffer.from(instructions).subarray(0, MAX_INSTRUCTIONS).toString("utf8").replace(/�$/, "");
    ctx.warnings.push(`${rel} instructions are over ${MAX_INSTRUCTIONS / 1024} KB: truncated`);
  }
  ctx.instructions = instructions;
  return ctx;
}

function readMrReview(front: Record<string, unknown>, rel: string, ctx: ProjectContext): void {
  for (const k of Object.keys(front)) if (k !== "mrReview") ctx.warnings.push(`unknown key "${k}" in ${rel}: ignored`);
  const mr = front.mrReview;
  if (mr === undefined || mr === null) return;
  if (typeof mr !== "object" || Array.isArray(mr)) {
    ctx.warnings.push(`mrReview in ${rel} is not a mapping: ignored`);
    return;
  }
  const r = mr as Record<string, unknown>;
  for (const k of Object.keys(r)) {
    if (!MR_REVIEW_KEYS.includes(k)) ctx.warnings.push(`unknown key "mrReview.${k}" in ${rel}: ignored`);
    else if (RESERVED.includes(k) && r[k] !== null) ctx.warnings.push(`mrReview.${k} in ${rel} is not supported yet: ignored`);
  }
  if (r.skill !== undefined && r.skill !== null) {
    const s = r.skill;
    const norm = typeof s === "string" ? path.posix.normalize(s) : "";
    if (typeof s !== "string" || !s.trim() || path.isAbsolute(s) || s.split(/[/\\]/).includes("..") || norm.startsWith("../")) {
      ctx.warnings.push(`mrReview.skill in ${rel} must be a path inside the repo, got ${JSON.stringify(s)}: ignored`);
    } else {
      ctx.mrReview.skill = norm;
    }
  }
  if (r.mode !== undefined && r.mode !== null && r.mode !== "read-only") {
    ctx.warnings.push(`mrReview.mode in ${rel} is ${JSON.stringify(r.mode)}; only read-only is supported: using read-only`);
  }
  if (ctx.mrReview.skill) ctx.mrReview.mode = "read-only";
}
