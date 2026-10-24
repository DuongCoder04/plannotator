import { afterAll, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readOwnFile, realFileInside } from "./safe-path";

const dir = mkdtempSync(join(tmpdir(), "pn-safe-path-"));
const root = join(dir, "repo");
const outside = join(dir, "secret.txt");
mkdirSync(join(root, "src"), { recursive: true });
writeFileSync(join(root, "src/a.ts"), "export const a = 1;\n");
writeFileSync(outside, "aws_secret_access_key = x\n");
symlinkSync(outside, join(root, "creds.txt"));
symlinkSync(join(root, "src/a.ts"), join(root, "alias.ts"));
symlinkSync(dir, join(root, "up"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("a repository file the Guide tab may open", () => {
  it("is a regular file inside the root", () => {
    expect(realFileInside(root, "src/a.ts")).toEndWith("src/a.ts");
    expect(realFileInside(root, "alias.ts")).toEndWith("src/a.ts");
  });

  it("never through a symlink out of the root, `..`, an absolute path or a folder", () => {
    expect(realFileInside(root, "creds.txt")).toBeNull();
    expect(realFileInside(root, "up/secret.txt")).toBeNull();
    expect(realFileInside(root, "../secret.txt")).toBeNull();
    expect(realFileInside(root, outside)).toBeNull();
    expect(realFileInside(root, "src")).toBeNull();
    expect(realFileInside(root, "missing.ts")).toBeNull();
  });

  it("reads only a file that is not a symlink at all", () => {
    expect(readOwnFile(root, "src/a.ts")?.toString()).toBe("export const a = 1;\n");
    expect(readOwnFile(root, "alias.ts")).toBeNull();
    expect(readOwnFile(root, "creds.txt")).toBeNull();
  });
});
