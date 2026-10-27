import { describe, expect, test } from "bun:test";
import { diffPosition, positionInDiff } from "../src/diffpos";

// new file: 1 ctx, 2 ctx, 3 ctx, 4 added "b", 5 ctx ...; old file: 10 removed.
const DIFF = [
  "diff --git a/src/a.ts b/src/a.ts",
  "index 111..222 100644",
  "--- a/src/a.ts",
  "+++ b/src/a.ts",
  "@@ -1,5 +1,6 @@",
  " one",
  " two",
  " three",
  "+four",
  " five",
  " six",
  "@@ -20,4 +21,3 @@",
  " twenty",
  "-gone",
  " twentyone",
  " twentytwo",
  "",
].join("\n");

const q = (line: number, side: "new" | "old" = "new") => ({ path: "src/a.ts", line, side });

describe("positionInDiff", () => {
  test("added line takes line only", () => {
    expect(positionInDiff(DIFF, q(4))).toEqual({ kind: "added", path: "src/a.ts", oldPath: "src/a.ts", side: "new", line: 4 });
  });

  test("removed line with side old takes oldLine only", () => {
    const p = positionInDiff(DIFF, q(21, "old"));
    expect(p).toEqual({ kind: "removed", path: "src/a.ts", oldPath: "src/a.ts", side: "old", oldLine: 21 });
    expect(p.line).toBeUndefined();
  });

  test("context line takes both", () => {
    expect(positionInDiff(DIFF, q(5))).toMatchObject({ kind: "context", line: 5, oldLine: 4 });
    expect(positionInDiff(DIFF, q(4, "old"))).toMatchObject({ kind: "context", line: 5, oldLine: 4 });
  });

  test("line between hunks is outside", () => {
    const p = positionInDiff(DIFF, q(12));
    expect(p).toEqual({ kind: "outside", path: "src/a.ts", oldPath: "src/a.ts", side: "new" });
    // a removed line is not addressable on side new
    expect(positionInDiff(DIFF, q(21)).kind).toBe("context");
  });

  test("renamed file uses oldPath", () => {
    const diff = [
      "diff --git a/old/x.ts b/new/x.ts",
      "similarity index 80%",
      "rename from old/x.ts",
      "rename to new/x.ts",
      "--- a/old/x.ts",
      "+++ b/new/x.ts",
      "@@ -1,2 +1,2 @@",
      "-before",
      "+after",
      " same",
      "",
    ].join("\n");
    const p = positionInDiff(diff, { path: "new/x.ts", oldPath: "old/x.ts", line: 1, side: "new" });
    expect(p).toEqual({ kind: "added", path: "new/x.ts", oldPath: "old/x.ts", side: "new", line: 1 });
  });

  test('"\\ No newline" lines are skipped', () => {
    const diff = ["@@ -1,2 +1,2 @@", "-a", "\\ No newline at end of file", "+b", "\\ No newline at end of file", " c", ""].join("\n");
    expect(positionInDiff(diff, q(2))).toMatchObject({ kind: "context", line: 2, oldLine: 2 });
    expect(positionInDiff(diff, q(1))).toMatchObject({ kind: "added", line: 1 });
  });

  test("a file header after a hunk ends the hunk", () => {
    const diff = ["@@ -1,1 +1,1 @@", " a", "diff --git a/o b/n", "+++ b/n", "+stray", ""].join("\n");
    expect(positionInDiff(diff, q(2)).kind).toBe("outside");
  });
});

describe("diffPosition", () => {
  test("runs git diff with the old path first when it differs", async () => {
    const calls: string[][] = [];
    const git = async (_cwd: string, args: string[]) => {
      calls.push(args);
      return { code: 0, stdout: "@@ -1,1 +1,1 @@\n-a\n+b\n", stderr: "" };
    };
    const p = await diffPosition(git, "/repo", "B", "H", { path: "n.ts", oldPath: "o.ts", line: 1, side: "new" });
    expect(calls[0]).toEqual(["diff", "--no-color", "--no-ext-diff", "-M", "-U3", "B", "H", "--", "o.ts", "n.ts"]);
    expect(p).toMatchObject({ kind: "added", oldPath: "o.ts", path: "n.ts", line: 1 });
    await diffPosition(git, "/repo", "B", "H", { path: "n.ts", line: 1, side: "new" });
    expect(calls[1].slice(-2)).toEqual(["--", "n.ts"]);
  });

  test("a failing git diff throws", async () => {
    const git = async () => ({ code: 128, stdout: "", stderr: "bad revision" });
    await expect(diffPosition(git, "/repo", "B", "H", { path: "n.ts", line: 1, side: "new" })).rejects.toThrow("bad revision");
  });
});
