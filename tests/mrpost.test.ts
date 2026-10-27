import { afterAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import { OrchError } from "../src/errors";
import type { GitRunner } from "../src/git";
import type { MrDeps, MrInfo } from "../src/mr";
import { appendUnposted, OutsideError, postReview, renderBody, type DryRun, type PostResult, type ReviewInput } from "../src/mrpost";
import { fakeForge, testRegistry, type FakeReply } from "./fakes";

type Handlers = Record<string, (args: string[], stdin?: string) => FakeReply>;

// src/a.ts — new 10 context (old 10); old 11 removed; new 11, 12 added; new 13 context (old 12); new 14 context (old 13).
const DIFF = [
  "diff --git a/src/a.ts b/src/a.ts",
  "--- a/src/a.ts",
  "+++ b/src/a.ts",
  "@@ -10,4 +10,5 @@",
  " ten",
  "-eleven",
  "+eleven2",
  "+twelve",
  " thirteen",
  " fourteen",
  "",
].join("\n");

let diffCalls = 0;
const git: GitRunner = async (_cwd, args) => {
  if (args[0] !== "diff") return { code: 0, stdout: "", stderr: "" };
  diffCalls++;
  return { code: 0, stdout: args.includes("src/a.ts") ? DIFF : "", stderr: "" };
};

// One temp dir and registry for the whole file, removed afterwards.
const REG = testRegistry(["shop-api"]);
const PROJECT_PATH = REG.projects[0].path;
afterAll(() => fs.rmSync(PROJECT_PATH, { recursive: true, force: true }));

function mrInfo(platform: "gitlab" | "github"): MrInfo {
  const gl = platform === "gitlab";
  return {
    platform,
    host: gl ? "gitlab.x.io" : "github.com",
    repo: gl ? "g/p" : "acme/shop",
    project: "shop-api",
    projectPath: PROJECT_PATH,
    number: gl ? 3 : 9,
    kind: gl ? "mr" : "pr",
    url: gl ? "https://gitlab.x.io/g/p/-/merge_requests/3" : "https://github.com/acme/shop/pull/9",
    title: "T",
    description: "",
    author: "bob",
    state: "open",
    draft: false,
    fork: false,
    sourceBranch: "feat",
    targetBranch: "dev",
    defaultBranch: "main",
    head: "h",
    base: "b",
    start: gl ? "s" : null,
    me: "me",
    nodeId: gl ? null : "PR_9",
  };
}

function setup(handlers: Handlers) {
  const forge = fakeForge(handlers);
  const deps: MrDeps = { reg: REG, git, forge };
  return { deps, forge };
}

const GL = "projects/g%2Fp/merge_requests/3";
const posts = (forge: ReturnType<typeof fakeForge>) => forge.calls.filter((c) => c.args.includes("POST") || c.args.includes("PUT") || c.args[1] === "graphql");
const stdinOf = (forge: ReturnType<typeof fakeForge>, path: string) => forge.calls.filter((c) => c.args.includes(path)).map((c) => JSON.parse(c.stdin ?? "null"));
const graphqlCalls = (forge: ReturnType<typeof fakeForge>) =>
  forge.calls.filter((c) => c.args[1] === "graphql").map((c) => JSON.parse(c.stdin ?? "{}") as { query: string; variables: { input: Record<string, unknown> } });
const opName = (q: string) => q.match(/mutation\s+(\w+)/)?.[1];

/** GitLab handlers: each discussion gets a positioned note with an increasing id. */
function glHandlers(over: Handlers = {}): Handlers {
  let id = 100;
  return {
    [`POST ${GL}/discussions`]: (_a, stdin) => {
      const body = JSON.parse(stdin ?? "{}");
      return { stdout: { id: `d${++id}`, notes: [{ id, body: body.body, position: body.position }] } };
    },
    [`POST ${GL}/notes`]: () => ({ stdout: { id: 999 } }),
    ...over,
  };
}

/** GitHub handlers for a pending review "R1" whose threads get urls by count. */
function ghHandlers(over: Handlers = {}): Handlers {
  let n = 0;
  return {
    "graphql AddReview": () => ({ stdout: { data: { addPullRequestReview: { pullRequestReview: { id: "R1" } } } } }),
    "graphql AddThread": () => {
      n++;
      return { stdout: { data: { addPullRequestReviewThread: { thread: { id: `T${n}`, comments: { nodes: [{ url: `https://github.com/acme/shop/pull/9#discussion_r${n}` }] } } } } } };
    },
    "graphql SubmitReview": () => ({ stdout: { data: { submitPullRequestReview: { pullRequestReview: { id: "R1", url: "https://github.com/acme/shop/pull/9#pullrequestreview-1" } } } } }),
    ...over,
  };
}

const input = (comments: ReviewInput["comments"], summary = "## Review\n\n2 findings"): ReviewInput => ({ summary, comments });

describe("postReview validation", () => {
  test("refuses before posting when a comment is outside", async () => {
    const t = setup(glHandlers());
    const err = await postReview(
      t.deps,
      mrInfo("gitlab"),
      input([
        { path: "src/a.ts", line: 12, body: "fine" },
        { path: "src/a.ts", line: 50, body: "far away" },
      ]),
    ).catch((e) => e);
    expect(err).toBeInstanceOf(OutsideError);
    expect((err as OutsideError).outside).toEqual([{ path: "src/a.ts", line: 50, body: "far away" }]);
    expect(posts(t.forge)).toEqual([]);
  });

  test("a suggestion reaching outside the hunk makes its comment outside", async () => {
    const t = setup(glHandlers());
    const err = await postReview(t.deps, mrInfo("gitlab"), input([{ path: "src/a.ts", line: 14, body: "x", suggestion: { text: "y", below: 1 } }])).catch((e) => e);
    expect(err).toBeInstanceOf(OutsideError);
    expect(posts(t.forge)).toEqual([]);
  });

  test("refuses a suggestion on a removed line", async () => {
    const t = setup(glHandlers());
    const err = await postReview(t.deps, mrInfo("gitlab"), input([{ path: "src/a.ts", line: 11, side: "old", body: "x", suggestion: { text: "y" } }])).catch((e) => e);
    expect(err).toBeInstanceOf(OrchError);
    expect(err).not.toBeInstanceOf(OutsideError);
    expect(String(err.message)).toContain("removed line");
    expect(posts(t.forge)).toEqual([]);
  });

  test("refuses malformed input", async () => {
    const t = setup(glHandlers());
    const bad = { summary: "s", comments: [{ path: "src/a.ts", line: 0, body: "x" }] } as ReviewInput;
    await expect(postReview(t.deps, mrInfo("gitlab"), bad)).rejects.toThrow("line");
    await expect(postReview(t.deps, mrInfo("gitlab"), { summary: " ", comments: [] })).rejects.toThrow("summary");
    expect(posts(t.forge)).toEqual([]);
  });

  test("dry run posts nothing", async () => {
    for (const platform of ["gitlab", "github"] as const) {
      const t = setup(platform === "gitlab" ? glHandlers() : ghHandlers());
      const c = { path: "src/a.ts", line: 12, body: "use x", suggestion: { text: "x" } };
      const r = (await postReview(t.deps, mrInfo(platform), input([c]), { dryRun: true })) as DryRun;
      expect(t.forge.calls).toEqual([]);
      expect(r.summary).toBe("## Review\n\n2 findings");
      expect(r.comments).toEqual([
        {
          path: "src/a.ts",
          line: 12,
          position: { kind: "added", path: "src/a.ts", oldPath: "src/a.ts", side: "new", line: 12 },
          body: renderBody(platform, c),
          payload:
            platform === "gitlab"
              ? { position_type: "text", base_sha: "b", start_sha: "s", head_sha: "h", old_path: "src/a.ts", new_path: "src/a.ts", new_line: 12 }
              : { path: "src/a.ts", line: 12, side: "RIGHT" },
        },
      ]);
    }
  });

  test("dry run shows a multi-line suggestion's range", async () => {
    const t = setup(ghHandlers());
    const c = { path: "src/a.ts", line: 12, body: "x", suggestion: { text: "a\nb\nc", above: 1, below: 1 } };
    const r = (await postReview(t.deps, mrInfo("github"), input([c]), { dryRun: true })) as DryRun;
    expect(r.comments[0].payload).toEqual({ path: "src/a.ts", line: 13, side: "RIGHT", startLine: 11, startSide: "RIGHT" });
    expect(t.forge.calls).toEqual([]);
  });

  test("reads each file's diff once, however many lines are checked", async () => {
    const t = setup(glHandlers());
    diffCalls = 0;
    await postReview(
      t.deps,
      mrInfo("gitlab"),
      input([
        { path: "src/a.ts", line: 12, body: "x", suggestion: { text: "a\nb\nc", above: 1, below: 1 } },
        { path: "src/a.ts", line: 13, body: "y" },
      ]),
      { dryRun: true },
    );
    expect(diffCalls).toBe(1);
  });
});

describe("renderBody", () => {
  test("renders suggestions per platform", () => {
    const c = { path: "src/a.ts", line: 12, body: "Use the helper.", suggestion: { text: "  permission: 'templates.manage',", above: 1, below: 2 } };
    expect(renderBody("gitlab", c)).toBe("Use the helper.\n\n```suggestion:-1+2\n  permission: 'templates.manage',\n```");
    expect(renderBody("github", c)).toBe("Use the helper.\n\n```suggestion\n  permission: 'templates.manage',\n```");
    expect(renderBody("gitlab", { ...c, suggestion: { text: "x" } })).toContain("```suggestion:-0+0\nx\n```");
    expect(renderBody("github", { path: "a", line: 1, body: "plain" })).toBe("plain");
  });

  test("an empty suggestion deletes the lines; a fenced one gets a longer fence", () => {
    expect(renderBody("github", { path: "a", line: 1, body: "drop", suggestion: { text: "" } })).toBe("drop\n\n```suggestion\n```");
    expect(renderBody("gitlab", { path: "a", line: 1, body: "b", suggestion: { text: "```js\nx\n```" } })).toBe("b\n\n````suggestion:-0+0\n```js\nx\n```\n````");
  });
});

describe("appendUnposted", () => {
  const failed = [{ path: "src/a.ts", line: 12, body: "**blocking**: breaks login.\n\nMore detail." }];

  test("returns the summary unchanged with no failures", () => {
    expect(appendUnposted("## Review", [])).toBe("## Review");
  });

  test("creates the heading at the end when absent", () => {
    expect(appendUnposted("## Review\n\nok\n", failed)).toBe("## Review\n\nok\n\n**Not on a changed line**\n\n- `src/a.ts:12` — **blocking**: breaks login.");
  });

  test("adds under an existing heading, after its list", () => {
    const summary = "## Review\n\n**Not on a changed line**\n\n- `b.ts:3` — old one\n\n**Checks on the head**\n\n- tests passed";
    expect(appendUnposted(summary, failed)).toBe(
      "## Review\n\n**Not on a changed line**\n\n- `b.ts:3` — old one\n- `src/a.ts:12` — **blocking**: breaks login.\n\n**Checks on the head**\n\n- tests passed",
    );
  });
});

describe("postReview on GitLab", () => {
  test("GitLab: line fields follow the line's kind", async () => {
    const t = setup(glHandlers());
    const r = (await postReview(
      t.deps,
      mrInfo("gitlab"),
      input([
        { path: "src/a.ts", line: 12, body: "added" },
        { path: "src/a.ts", line: 11, side: "old", body: "removed" },
        { path: "src/a.ts", line: 13, body: "context" },
      ]),
    )) as PostResult;
    const sent = stdinOf(t.forge, `${GL}/discussions`);
    const base = { position_type: "text", base_sha: "b", start_sha: "s", head_sha: "h", old_path: "src/a.ts", new_path: "src/a.ts" };
    expect(sent).toEqual([
      { body: "added", position: { ...base, new_line: 12 } },
      { body: "removed", position: { ...base, old_line: 11 } },
      { body: "context", position: { ...base, old_line: 12, new_line: 13 } },
    ]);
    expect(r.comments.map((c) => c.status)).toEqual(["placed", "placed", "placed"]);
    expect(r.comments[0]).toEqual({ path: "src/a.ts", line: 12, status: "placed", url: "https://gitlab.x.io/g/p/-/merge_requests/3#note_101" });
    expect(r.summaryUrl).toBe("https://gitlab.x.io/g/p/-/merge_requests/3#note_999");
    // the summary goes last, unchanged when nothing failed
    expect(t.forge.calls.at(-1)?.args).toContain(`${GL}/notes`);
    expect(stdinOf(t.forge, `${GL}/notes`)).toEqual([{ body: "## Review\n\n2 findings" }]);
  });

  test("GitLab: a note without position is unplaced and not re-posted", async () => {
    const t = setup(glHandlers({ [`POST ${GL}/discussions`]: () => ({ stdout: { id: "d1", notes: [{ id: 7, body: "x" }] } }) }));
    const r = (await postReview(t.deps, mrInfo("gitlab"), input([{ path: "src/a.ts", line: 12, body: "x" }]))) as PostResult;
    expect(r.comments).toEqual([{ path: "src/a.ts", line: 12, status: "unplaced", url: "https://gitlab.x.io/g/p/-/merge_requests/3#note_7" }]);
    expect(stdinOf(t.forge, `${GL}/discussions`)).toHaveLength(1);
    expect(stdinOf(t.forge, `${GL}/notes`)[0].body).not.toContain("Not on a changed line");
  });

  test("GitLab: a 400 is retried once, then failed, and the summary lists it", async () => {
    let tries = 0;
    const t = setup(
      glHandlers({
        [`POST ${GL}/discussions`]: (_a, stdin) => {
          const body = JSON.parse(stdin ?? "{}");
          if (body.body === "bad") {
            tries++;
            return { code: 1, stderr: "glab: 400 Bad Request", stdout: '{"message":"line_code is invalid"}' };
          }
          return { stdout: { id: "d2", notes: [{ id: 8, position: body.position }] } };
        },
      }),
    );
    const r = (await postReview(
      t.deps,
      mrInfo("gitlab"),
      input([
        { path: "src/a.ts", line: 12, body: "bad" },
        { path: "src/a.ts", line: 13, body: "good" },
      ]),
    )) as PostResult;
    expect(tries).toBe(2);
    expect(r.comments[0]).toMatchObject({ path: "src/a.ts", line: 12, status: "failed" });
    expect(r.comments[0].error).toContain("line_code is invalid");
    expect(r.comments[1]).toMatchObject({ status: "placed" });
    const summary = stdinOf(t.forge, `${GL}/notes`)[0].body as string;
    expect(summary).toContain("**Not on a changed line**");
    expect(summary).toContain("`src/a.ts:12`");
    expect(summary).toContain("bad");
  });

  test("GitLab: a failed summary note says what was posted", async () => {
    const t = setup(glHandlers({ [`POST ${GL}/notes`]: () => ({ code: 1, stderr: "glab: 500 Internal Server Error" }) }));
    const err = await postReview(t.deps, mrInfo("gitlab"), input([{ path: "src/a.ts", line: 12, body: "x" }])).catch((e) => e);
    expect(err).toBeInstanceOf(OrchError);
    expect(err.message).toContain("summary");
    expect(err.message).toContain("#note_101");
  });
});

describe("postReview on GitHub", () => {
  test("GitHub: one pending review, threads added one by one, submitted as COMMENT", async () => {
    const t = setup(ghHandlers());
    const r = (await postReview(
      t.deps,
      mrInfo("github"),
      input([
        { path: "src/a.ts", line: 12, body: "added" },
        { path: "src/a.ts", line: 11, side: "old", body: "removed" },
        { path: "src/a.ts", line: 13, body: "context" },
      ]),
    )) as PostResult;
    const calls = graphqlCalls(t.forge);
    expect(calls.map((c) => opName(c.query))).toEqual(["AddReview", "AddThread", "AddThread", "AddThread", "SubmitReview"]);
    expect(calls[0].variables.input).toEqual({ pullRequestId: "PR_9", commitOID: "h" });
    expect(calls[0].variables.input.event).toBeUndefined();
    expect(calls.slice(1, 4).map((c) => c.variables.input)).toEqual([
      { pullRequestReviewId: "R1", path: "src/a.ts", line: 12, side: "RIGHT", body: "added" },
      { pullRequestReviewId: "R1", path: "src/a.ts", line: 11, side: "LEFT", body: "removed" },
      { pullRequestReviewId: "R1", path: "src/a.ts", line: 13, side: "RIGHT", body: "context" },
    ]);
    expect(calls[4].variables.input).toEqual({ pullRequestReviewId: "R1", event: "COMMENT", body: "## Review\n\n2 findings" });
    expect(r.comments.map((c) => [c.status, c.url])).toEqual([
      ["placed", "https://github.com/acme/shop/pull/9#discussion_r1"],
      ["placed", "https://github.com/acme/shop/pull/9#discussion_r2"],
      ["placed", "https://github.com/acme/shop/pull/9#discussion_r3"],
    ]);
    expect(r.summaryUrl).toBe("https://github.com/acme/shop/pull/9#pullrequestreview-1");
    expect(t.forge.calls.some((c) => (c.stdin ?? "").includes("APPROVE") || (c.stdin ?? "").includes("REQUEST_CHANGES"))).toBe(false);
  });

  test("GitHub: a multi-line suggestion sets startLine and line", async () => {
    const t = setup(ghHandlers());
    await postReview(
      t.deps,
      mrInfo("github"),
      input([
        { path: "src/a.ts", line: 12, body: "both", suggestion: { text: "a\nb\nc", above: 1, below: 1 } },
        { path: "src/a.ts", line: 11, body: "below only", suggestion: { text: "a\nb", below: 1 } },
      ]),
    );
    const threads = graphqlCalls(t.forge).filter((c) => opName(c.query) === "AddThread").map((c) => c.variables.input);
    expect(threads[0]).toMatchObject({ startLine: 11, startSide: "RIGHT", line: 13, side: "RIGHT" });
    expect(threads[0].body).toBe("both\n\n```suggestion\na\nb\nc\n```");
    expect(threads[1]).toMatchObject({ startLine: 11, startSide: "RIGHT", line: 12, side: "RIGHT" });
  });

  test("GitHub: a rejected thread is failed and moved to the summary; the rest still post", async () => {
    let n = 0;
    const t = setup(
      ghHandlers({
        "graphql AddThread": () => {
          n++;
          if (n === 1) return { code: 1, stdout: { errors: [{ message: "Line could not be resolved" }] } };
          return { stdout: { data: { addPullRequestReviewThread: { thread: { id: "T2", comments: { nodes: [{ url: "u2" }] } } } } } };
        },
      }),
    );
    const r = (await postReview(
      t.deps,
      mrInfo("github"),
      input([
        { path: "src/a.ts", line: 12, body: "rejected one" },
        { path: "src/a.ts", line: 13, body: "fine" },
      ]),
    )) as PostResult;
    expect(r.comments).toEqual([
      { path: "src/a.ts", line: 12, status: "failed", error: "Line could not be resolved" },
      { path: "src/a.ts", line: 13, status: "placed", url: "u2" },
    ]);
    const submit = graphqlCalls(t.forge).find((c) => opName(c.query) === "SubmitReview")!;
    expect(submit.variables.input.event).toBe("COMMENT");
    expect(submit.variables.input.body).toContain("**Not on a changed line**");
    expect(submit.variables.input.body).toContain("- `src/a.ts:12` — rejected one");
  });

  test("GitHub: a thread that comes back null is failed, not dropped", async () => {
    const t = setup(ghHandlers({ "graphql AddThread": () => ({ stdout: { data: { addPullRequestReviewThread: { thread: null } } } }) }));
    const r = (await postReview(t.deps, mrInfo("github"), input([{ path: "src/a.ts", line: 12, body: "x" }]))) as PostResult;
    expect(r.comments[0].status).toBe("failed");
    const submit = graphqlCalls(t.forge).find((c) => opName(c.query) === "SubmitReview")!;
    expect(submit.variables.input.body).toContain("`src/a.ts:12`");
  });

  test("explains a leftover pending review", async () => {
    const t = setup(
      ghHandlers({
        "graphql AddReview": () => ({ code: 1, stdout: { errors: [{ message: "User can only have one pending review per pull request" }] } }),
      }),
    );
    const err = await postReview(t.deps, mrInfo("github"), input([{ path: "src/a.ts", line: 12, body: "x" }])).catch((e) => e);
    expect(err).toBeInstanceOf(OrchError);
    expect(err.message).toContain("pending review");
    expect(err.message).toContain("submit or discard");
    expect(graphqlCalls(t.forge).map((c) => opName(c.query))).toEqual(["AddReview"]);
  });

  test("GitHub: any error after the review exists says it is still pending", async () => {
    const t = setup(
      ghHandlers({
        "graphql AddReview": () => ({ stdout: { data: { addPullRequestReview: { pullRequestReview: { id: "R1", url: "https://github.com/acme/shop/pull/9#pullrequestreview-1" } } } } }),
        "graphql AddThread": () => {
          throw new Error("socket hang up");
        },
      }),
    );
    const err = await postReview(t.deps, mrInfo("github"), input([{ path: "src/a.ts", line: 12, body: "x" }])).catch((e) => e);
    expect(err).toBeInstanceOf(OrchError);
    expect(err.message).toContain("socket hang up");
    expect(err.message).toContain("review R1");
    expect(err.message).toContain("still pending on https://github.com/acme/shop/pull/9#pullrequestreview-1");
    expect(err.message).toContain("submit or discard");
  });

  test("GitHub: a failed submit says the review is still pending", async () => {
    const t = setup(ghHandlers({ "graphql SubmitReview": () => ({ code: 1, stdout: { errors: [{ message: "boom" }] } }) }));
    const err = await postReview(t.deps, mrInfo("github"), input([{ path: "src/a.ts", line: 12, body: "x" }])).catch((e) => e);
    expect(err).toBeInstanceOf(OrchError);
    expect(err.message).toContain("boom");
    expect(err.message).toContain("pending");
    expect(err.message).toContain("discussion_r1");
  });
});
