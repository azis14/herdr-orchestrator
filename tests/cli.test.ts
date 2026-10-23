import { describe, expect, test } from "bun:test";
import { main } from "../orch";
import { testDeps } from "./fakes";

describe("cli open", () => {
  test("opens with default agent", async () => {
    const { deps, out } = await testDeps();
    expect(await main(["open", "shop-api"], deps)).toBe(0);
    expect(out.join("\n")).toStartWith("opened shop-api-claude-1 (claude) in shop-api");
  });

  test("unknown project returns 1 and lists known projects", async () => {
    const { deps, err } = testDeps();
    expect(await main(["open", "nope"], deps)).toBe(1);
    expect(err.join("\n")).toContain("shop-api");
  });

  test("no subcommand prints usage and returns 2", async () => {
    const { deps, err } = testDeps();
    expect(await main([], deps)).toBe(2);
    expect(err.join("\n")).toContain("usage");
  });
});
