import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { formatBytes, uniqueBytes } from "../src/disk";

describe("uniqueBytes", () => {
  test("counts files with one link and skips hard-linked ones", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "orch-disk-"));
    fs.writeFileSync(path.join(dir, "a"), "x".repeat(1000));
    fs.writeFileSync(path.join(dir, "b"), "y".repeat(500));
    fs.linkSync(path.join(dir, "b"), path.join(dir, "b2"));
    expect(await uniqueBytes(dir)).toBe(1000);
  });

  test("returns null for a missing dir", async () => {
    expect(await uniqueBytes(path.join(os.tmpdir(), "orch-disk-does-not-exist"))).toBeNull();
  });
});

describe("formatBytes", () => {
  test("base 1024, GB with a decimal, MB and KB whole", () => {
    expect(formatBytes(0)).toBe("0 KB");
    expect(formatBytes(12 * 1024)).toBe("12 KB");
    expect(formatBytes(477 * 1024 ** 2)).toBe("477 MB");
    expect(formatBytes(1.25 * 1024 ** 3)).toBe("1.3 GB");
  });
});
