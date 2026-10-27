import { describe, expect, test } from "bun:test";
import { fakeForge } from "./fakes";
import { Forge, forgeRunner, ForgeError, parseJsonStream, type ForgeRunner } from "../src/forge";

const HOST = "gitlab.acclime.cloud";

function stub(reply: { code?: number; stdout?: string; stderr?: string }) {
  const calls: { args: string[]; stdin?: string }[] = [];
  const run: ForgeRunner = async (_bin, args, stdin) => {
    calls.push({ args, stdin });
    return { code: reply.code ?? 0, stdout: reply.stdout ?? "", stderr: reply.stderr ?? "" };
  };
  return { run, calls };
}

describe("Forge", () => {
  test("glab calls carry hostname and pipe the body on stdin", async () => {
    const s = stub({ stdout: "{}" });
    await new Forge(s.run, "gitlab", HOST).rest("POST", "projects/x/notes", { body: "hi" });
    expect(s.calls).toEqual([
      { args: ["api", "--hostname", HOST, "--method", "POST", "projects/x/notes", "--input", "-"], stdin: '{"body":"hi"}' },
    ]);
  });

  test("gh calls have no hostname and no stdin without a body", async () => {
    const s = stub({ stdout: "{}" });
    await new Forge(s.run, "github", "github.com").rest("GET", "repos/a/b/pulls/1");
    expect(s.calls).toEqual([{ args: ["api", "--method", "GET", "repos/a/b/pulls/1"], stdin: undefined }]);
  });

  test("parses concatenated pages", async () => {
    expect(parseJsonStream('[{"a":1}][{"a":2}]\n')).toEqual([[{ a: 1 }], [{ a: 2 }]]);
    const s = stub({ stdout: '[{"a":1}][{"a":2}]\n' });
    const r = await new Forge(s.run, "gitlab", HOST).rest("GET", "projects/x/notes", undefined, { paginate: true });
    expect(r).toEqual([{ a: 1 }, { a: 2 }]);
    expect(s.calls[0].args).toEqual(["api", "--hostname", HOST, "--method", "GET", "projects/x/notes", "--paginate"]);
  });

  test("parseJsonStream copes with braces inside strings", () => {
    expect(parseJsonStream('{"a":"}]\\"{"}\n{"b":2}')).toEqual([{ a: '}]"{' }, { b: 2 }]);
  });

  test("gh paginate uses --slurp and flattens", async () => {
    const s = stub({ stdout: "[[1],[2]]" });
    const r = await new Forge(s.run, "github", "github.com").rest("GET", "repos/a/b/pulls", undefined, { paginate: true });
    expect(r).toEqual([1, 2]);
    expect(s.calls[0].args).toEqual(["api", "--method", "GET", "repos/a/b/pulls", "--paginate", "--slurp"]);
  });

  test("stderr warnings alone are not failures", async () => {
    const s = stub({ code: 0, stderr: "WARNING: cannot start document portal", stdout: "{}" });
    expect(await new Forge(s.run, "gitlab", HOST).rest("GET", "user")).toEqual({});
  });

  test("failure carries the HTTP status", async () => {
    const g = stub({ code: 1, stderr: "glab: 422 Unprocessable Entity" });
    const e1 = await new Forge(g.run, "gitlab", HOST).rest("POST", "x", {}).catch((e) => e);
    expect(e1).toBeInstanceOf(ForgeError);
    expect(e1.status).toBe(422);
    const h = stub({ code: 1, stderr: "gh: Not Found (HTTP 404)" });
    const e2 = await new Forge(h.run, "github", "github.com").rest("GET", "x").catch((e) => e);
    expect(e2).toBeInstanceOf(ForgeError);
    expect(e2.status).toBe(404);
  });

  test("not logged in says how to log in", async () => {
    const g = stub({ code: 1, stderr: "glab: 401 Unauthorized" });
    const e1 = await new Forge(g.run, "gitlab", HOST).rest("GET", "user").catch((e) => e);
    expect(e1.message.endsWith(`! glab auth login --hostname ${HOST}`)).toBe(true);
    const h = stub({ code: 4, stderr: "To get started with GitHub CLI, please run:  gh auth login" });
    const e2 = await new Forge(h.run, "github", "github.com").rest("GET", "user").catch((e) => e);
    expect(e2.message.endsWith("! gh auth login")).toBe(true);
  });

  test("failure includes the response body from stdout", async () => {
    const g = stub({ code: 1, stderr: "glab: 409 Conflict", stdout: '{"message":"Branch already exists"}' });
    const e = await new Forge(g.run, "gitlab", HOST).rest("POST", "x", {}).catch((e) => e);
    expect(e.status).toBe(409);
    expect(e.message).toContain("glab: 409 Conflict");
    expect(e.message).toContain('{"message":"Branch already exists"}');
  });

  test("an empty paginated response is an empty list", async () => {
    const s = stub({ stdout: "" });
    expect(await new Forge(s.run, "gitlab", HOST).rest("GET", "x", undefined, { paginate: true })).toEqual([]);
    expect(await new Forge(s.run, "gitlab", HOST).rest("GET", "x")).toBeNull();
  });

  test("a missing binary says it is not installed", async () => {
    const saved = process.env.PATH;
    process.env.PATH = "/nonexistent-orch-test-dir";
    try {
      const e = await forgeRunner("glab", ["--version"]).catch((e) => e);
      expect(e).toBeInstanceOf(ForgeError);
      expect(e.message).toBe("glab is not installed (needed for /mr-review and /mr-fix)");
    } finally {
      process.env.PATH = saved;
    }
  });

  test("graphql sends query and variables on stdin and returns data", async () => {
    const s = stub({ stdout: '{"data":{"x":1}}' });
    const r = await new Forge(s.run, "github", "github.com").graphql("query Q { x }", { a: 1 });
    expect(r).toEqual({ x: 1 });
    expect(s.calls).toEqual([
      { args: ["api", "graphql", "--input", "-"], stdin: JSON.stringify({ query: "query Q { x }", variables: { a: 1 } }) },
    ]);
  });

  test("graphql throws on errors", async () => {
    const s = stub({ stdout: '{"errors":[{"message":"boom"}]}' });
    const e = await new Forge(s.run, "github", "github.com").graphql("query Q { x }", {}).catch((e) => e);
    expect(e).toBeInstanceOf(ForgeError);
    expect(e.message).toContain("boom");
  });

  test("graphql is github only", async () => {
    const s = stub({});
    await expect(new Forge(s.run, "gitlab", HOST).graphql("query Q { x }", {})).rejects.toThrow(ForgeError);
    expect(s.calls).toEqual([]);
  });
});

describe("fakeForge", () => {
  test("keys api calls on method and path without query, graphql on the operation name", async () => {
    const f = fakeForge({
      "GET projects/a%2Fb/merge_requests/42": () => ({ stdout: { iid: 42 } }),
      "graphql addPullRequestReview": (_a, stdin) => ({ stdout: { data: { got: JSON.parse(stdin!).variables } } }),
    });
    const gl = new Forge(f, "gitlab", HOST);
    expect(await gl.rest("GET", "projects/a%2Fb/merge_requests/42?per_page=100")).toEqual({ iid: 42 });
    const gh = new Forge(f, "github", "github.com");
    expect(await gh.graphql("mutation addPullRequestReview($id: ID!) { x }", { id: "1" })).toEqual({ got: { id: "1" } });
    expect(await gh.graphql("mutation { addPullRequestReview(input: {}) { x } }", {})).toEqual({ got: {} });
    await expect(gl.rest("GET", "nope")).rejects.toThrow("fakeForge: unhandled call");
  });
});
