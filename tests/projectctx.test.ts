import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { OrchError } from "../src/errors";
import { loadProjectContext, MAX_INSTRUCTIONS } from "../src/projectctx";

function regDir(files: Record<string, string> = {}): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "orch-ctx-"));
  fs.mkdirSync(path.join(dir, "projects"));
  for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(dir, "projects", `${name}.md`), text);
  return dir;
}

const load = (text: string) => loadProjectContext(regDir({ shop: text }), "shop");

describe("loadProjectContext", () => {
  test("absent file is not present, with no warning", () => {
    const dir = regDir();
    expect(loadProjectContext(dir, "shop")).toEqual({
      present: false,
      path: path.join(dir, "projects", "shop.md"),
      mrReview: {},
      instructions: "",
      warnings: [],
    });
    // no projects/ dir at all
    expect(loadProjectContext(fs.mkdtempSync(path.join(os.tmpdir(), "orch-ctx-")), "shop").present).toBe(false);
  });

  test("body only: the whole body is the instructions", () => {
    const c = load("# shop\nUse the staging DB.\n");
    expect(c.present).toBe(true);
    expect(c.mrReview).toEqual({});
    expect(c.instructions).toBe("# shop\nUse the staging DB.");
    expect(c.warnings).toEqual([]);
  });

  test("valid frontmatter sets the review skill, read-only; the ## mr-review section is the instructions", () => {
    const c = load(
      "---\nmrReview:\n  skill: ./pdlc/skills/review/SKILL.md\n  mode: read-only\n  model: null\n  checks: null\n---\n" +
        "# shop\nGeneral notes.\n## mr-review\nInfer the REQ from the branch.\n## mr-fix\nOther.\n",
    );
    expect(c.mrReview).toEqual({ skill: "pdlc/skills/review/SKILL.md", mode: "read-only" });
    expect(c.instructions).toBe("Infer the REQ from the branch.");
    expect(c.warnings).toEqual([]);
  });

  test("## mr-review as the last section runs to the end of the file", () => {
    expect(load("intro\n## mr-review\nline 1\nline 2\n").instructions).toBe("line 1\nline 2");
  });

  test("invalid YAML: warning, body kept", () => {
    const c = load("---\nmrReview: [unclosed\n---\nnotes\n");
    expect(c.present).toBe(true);
    expect(c.mrReview).toEqual({});
    expect(c.instructions).toBe("notes");
    expect(c.warnings).toHaveLength(1);
    expect(c.warnings[0]).toStartWith("invalid frontmatter in registry/projects/shop.md:");
  });

  test("non-mapping or unterminated frontmatter: warning", () => {
    for (const text of ["---\n- a\n- b\n---\nnotes\n", "---\njust a string\n---\nnotes\n"]) {
      const c = load(text);
      expect(c.instructions).toBe("notes");
      expect(c.warnings).toEqual(["invalid frontmatter in registry/projects/shop.md: not a mapping"]);
    }
    const c = load("---\nmrReview:\n  skill: a.md\nnotes\n");
    expect(c.mrReview).toEqual({});
    expect(c.warnings).toEqual(["invalid frontmatter in registry/projects/shop.md: no closing ---"]);
  });

  test("empty frontmatter is fine", () => {
    expect(load("---\n---\nnotes\n")).toMatchObject({ instructions: "notes", warnings: [] });
  });

  test("absolute or escaping skill path is rejected with a warning", () => {
    for (const skill of ["/etc/passwd", "../other/SKILL.md", "a/../../b.md", "a/../b.md", '""']) {
      const c = load(`---\nmrReview:\n  skill: ${skill}\n---\n`);
      expect(c.mrReview).toEqual({});
      expect(c.warnings).toHaveLength(1);
      expect(c.warnings[0]).toContain("must be a path inside the repo");
    }
  });

  test("unknown keys, reserved keys and other modes warn; mode is forced read-only", () => {
    const c = load("---\nnotes: x\nmrReview:\n  skill: r.md\n  mode: write\n  model: big\n  extra: 1\n---\n");
    expect(c.mrReview).toEqual({ skill: "r.md", mode: "read-only" });
    expect(c.warnings).toEqual([
      'unknown key "notes" in registry/projects/shop.md: ignored',
      "mrReview.model in registry/projects/shop.md is not supported yet: ignored",
      'unknown key "mrReview.extra" in registry/projects/shop.md: ignored',
      'mrReview.mode in registry/projects/shop.md is "write"; only read-only is supported: using read-only',
    ]);
  });

  test("oversize instructions are truncated with a warning", () => {
    const c = load("x".repeat(MAX_INSTRUCTIONS + 10));
    expect(Buffer.byteLength(c.instructions)).toBe(MAX_INSTRUCTIONS);
    expect(c.warnings).toEqual(["registry/projects/shop.md instructions are over 64 KB: truncated"]);
  });

  test("a symlink out of registry/projects/ is rejected", () => {
    const dir = regDir();
    const outside = path.join(dir, "secret.md");
    fs.writeFileSync(outside, "secret");
    fs.symlinkSync(outside, path.join(dir, "projects", "shop.md"));
    const c = loadProjectContext(dir, "shop");
    expect(c).toMatchObject({ present: false, instructions: "" });
    expect(c.warnings).toEqual(["ignored registry/projects/shop.md: it links outside registry/projects/"]);
  });

  test("a project name that isn't a plain file name is refused", () => {
    const dir = regDir();
    for (const name of ["../x", "a/b", "..", "", "a b"]) {
      expect(() => loadProjectContext(dir, name)).toThrow(OrchError);
    }
    // dots are fine (shop2.0)
    expect(loadProjectContext(dir, "shop2.0").present).toBe(false);
  });
});
