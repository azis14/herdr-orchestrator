import { describe, expect, test } from "bun:test";
import { testRegistry } from "./fakes";
import { OrchError } from "../src/errors";
import type { GitRunner } from "../src/git";
import type { Registry } from "../src/registry";
import { parseMrUrl, parseRemote, resolveRef } from "../src/mrref";

/** A fake git whose `remote get-url origin` answers per project path. */
function gitWithOrigins(reg: Registry, origins: Record<string, string>): GitRunner {
  const byPath = new Map(reg.projects.map((p) => [p.path, origins[p.name]]));
  return async (cwd, args) => {
    const origin = byPath.get(cwd);
    if (args.join(" ") === "remote get-url origin" && origin) return { code: 0, stdout: `${origin}\n`, stderr: "" };
    return { code: 128, stdout: "", stderr: "fatal: no such remote 'origin'" };
  };
}

describe("parseMrUrl", () => {
  test("parses nested groups and trailing tails", () => {
    expect(parseMrUrl("https://gitlab.acclime.cloud/group/sub/proj/-/merge_requests/42/diffs#note_9")).toEqual({
      platform: "gitlab",
      host: "gitlab.acclime.cloud",
      repo: "group/sub/proj",
      number: 42,
    });
    expect(parseMrUrl("https://github.com/azis14/work-journal/pull/7/files?w=1")).toEqual({
      platform: "github",
      host: "github.com",
      repo: "azis14/work-journal",
      number: 7,
    });
    expect(parseMrUrl("https://example.com/foo")).toBeNull();
    expect(parseMrUrl("not a url")).toBeNull();
  });

  test("a malformed percent-escape is no MR, not a crash", () => {
    expect(parseMrUrl("https://gitlab.x.io/g/%E0%A4%A/-/merge_requests/1")).toBeNull();
    expect(parseMrUrl("https://github.com/a/%E0%A4%A/pull/1")).toBeNull();
  });
});

describe("parseRemote", () => {
  test("matches remotes in every form, case-insensitively", () => {
    const want = { host: "gitlab.acclime.cloud", repo: "sandbox/sdp" };
    for (const url of [
      "git@gitlab.acclime.cloud:Sandbox/SDP.git",
      "ssh://git@gitlab.acclime.cloud:2222/sandbox/sdp.git",
      "https://gitlab.acclime.cloud/sandbox/sdp",
    ]) {
      const r = parseRemote(url);
      expect(r && { host: r.host.toLowerCase(), repo: r.repo.toLowerCase() }).toEqual(want);
    }
    expect(parseRemote("")).toBeNull();
  });

  test("a malformed percent-escape is no remote, not a crash", () => {
    expect(parseRemote("https://gitlab.x.io/g/%E0%A4%A.git")).toBeNull();
  });
});

describe("resolveRef", () => {
  test("one project with a malformed origin doesn't stop the scan", async () => {
    const reg = testRegistry(["broken", "shop-ui"]);
    const git = gitWithOrigins(reg, {
      broken: "https://gitlab.acclime.cloud/x/%E0%A4%A.git",
      "shop-ui": "git@gitlab.acclime.cloud:shop/ui.git",
    });
    const r = await resolveRef(reg, git, ["https://gitlab.acclime.cloud/shop/ui/-/merge_requests/5"]);
    expect(r.project.name).toBe("shop-ui");
  });

  test("a URL resolves to the project whose origin matches", async () => {
    const reg = testRegistry(["shop-api", "shop-ui"]);
    const git = gitWithOrigins(reg, {
      "shop-api": "git@gitlab.acclime.cloud:Shop/API.git",
      "shop-ui": "git@gitlab.acclime.cloud:shop/ui.git",
    });
    const r = await resolveRef(reg, git, ["https://gitlab.acclime.cloud/shop/ui/-/merge_requests/5"]);
    expect(r.project.name).toBe("shop-ui");
    expect(r).toMatchObject({ platform: "gitlab", host: "gitlab.acclime.cloud", repo: "shop/ui", number: 5 });
  });

  test("project plus id", async () => {
    const reg = testRegistry(["shop-api", "shop-ui"]);
    const git = gitWithOrigins(reg, {
      "shop-api": "git@gitlab.acclime.cloud:shop/api.git",
      "shop-ui": "https://github.com/acme/shop-ui.git",
    });
    const a = await resolveRef(reg, git, ["shop-api", "!42"]);
    expect(a).toMatchObject({ platform: "gitlab", host: "gitlab.acclime.cloud", repo: "shop/api", number: 42 });
    expect(a.project.name).toBe("shop-api");
    const b = await resolveRef(reg, git, ["shop-ui", "#7"]);
    expect(b).toMatchObject({ platform: "github", host: "github.com", repo: "acme/shop-ui", number: 7 });
    expect((await resolveRef(reg, git, ["shop-api", "9"])).number).toBe(9);
  });

  test("no match names the remote and suggests /register", async () => {
    const reg = testRegistry(["shop-api"]);
    const git = gitWithOrigins(reg, { "shop-api": "git@gitlab.acclime.cloud:shop/api.git" });
    const err = await resolveRef(reg, git, ["https://gitlab.acclime.cloud/other/repo/-/merge_requests/1"]).catch((e) => e);
    expect(err).toBeInstanceOf(OrchError);
    expect(err.message).toContain("gitlab.acclime.cloud/other/repo");
    expect(err.message).toContain("/register");
  });

  test("several matches list the projects", async () => {
    const reg = testRegistry(["shop-api", "shop-api-copy"]);
    const git = gitWithOrigins(reg, {
      "shop-api": "git@gitlab.acclime.cloud:shop/api.git",
      "shop-api-copy": "https://gitlab.acclime.cloud/shop/api.git",
    });
    const err = await resolveRef(reg, git, ["https://gitlab.acclime.cloud/shop/api/-/merge_requests/1"]).catch((e) => e);
    expect(err).toBeInstanceOf(OrchError);
    expect(err.message).toContain("shop-api");
    expect(err.message).toContain("shop-api-copy");
    expect(err.message).toContain("<project> <id>");
  });

  test("bad id or arg count gives usage", async () => {
    const reg = testRegistry(["shop-api"]);
    const git = gitWithOrigins(reg, { "shop-api": "git@gitlab.acclime.cloud:shop/api.git" });
    for (const args of [["shop-api", "abc"], [], ["a", "!1", "extra"], ["https://example.com/foo"]]) {
      const err = await resolveRef(reg, git, args).catch((e) => e);
      expect(err).toBeInstanceOf(OrchError);
      expect(err.message).toContain("usage: mr");
    }
  });
});
