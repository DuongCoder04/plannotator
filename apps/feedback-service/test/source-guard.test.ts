/**
 * The owner's rule for this Worker: the public endpoint can only submit,
 * never read, and never change or remove what is already stored. This test
 * reads the Worker's own source (everything wrangler bundles: core/, stores/,
 * targets/) and fails on any SQL verb but INSERT, any D1 read method, any
 * second statement, and any route but POST /feedback.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const root = join(import.meta.dir, "..");
const sourceDirs = ["core", "stores", "targets"].map((dir) => join(root, dir));

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    return statSync(full).isDirectory() ? walk(full) : /\.[cm]?[jt]s$/.test(name) ? [full] : [];
  });
}

const files = sourceDirs.flatMap(walk);
const sources = files.map((file) => ({ file: relative(root, file), text: readFileSync(file, "utf-8") }));

describe("the Worker only ever inserts", () => {
  test("the guard sees the Worker's files (it cannot pass on an empty set)", () => {
    const names = sources.map((s) => s.file).sort();
    expect(names).toContain("core/handler.ts");
    expect(names).toContain("stores/d1.ts");
    expect(names).toContain("targets/cloudflare.ts");
  });

  test("no SQL verb but INSERT appears anywhere in the source, comments included", () => {
    // A JavaScript method call (`map.delete(key)`, `text.replace(re, "")`) is not SQL: a word right after a
    // `.` is skipped. Everything else counts, comments and strings included.
    const banned = /(?<!\.)\b(select|update|delete|replace|drop|alter|upsert|truncate|pragma|attach|vacuum|returning|create)\b|\bon\s+conflict\b|\bor\s+ignore\b/i;
    for (const { file, text } of sources) {
      expect(banned.exec(text)?.[0] ?? null, `${file} contains a banned SQL word`).toBeNull();
    }
  });

  test("no D1 read or multi-statement method is called", () => {
    const readMethods = /\.(first|all|raw|exec|batch|dump|withSession)\s*\(/;
    for (const { file, text } of sources) {
      expect(readMethods.exec(text)?.[0] ?? null, `${file} calls a D1 read method`).toBeNull();
    }
  });

  test("exactly one prepared statement, a parameterised INSERT into feedback", () => {
    const prepared = sources.flatMap(({ file, text }) => [...text.matchAll(/\.prepare\(\s*`([^`]*)`/g)].map((m) => ({ file, sql: m[1]!.replace(/\s+/g, " ").trim() })));
    expect(prepared).toHaveLength(1);
    expect(prepared[0]!.file).toBe("stores/d1.ts");
    expect(prepared[0]!.sql).toMatch(/^INSERT INTO feedback \([a-z_, ]+\) VALUES \((\?, )*\?\)$/);
    // No `${...}` interpolation into SQL: values go through bind().
    expect(prepared[0]!.sql).not.toContain("${");
    // Every `.prepare(` call is the template one above (no string-built SQL).
    const calls = sources.reduce((n, { text }) => n + (text.match(/\.prepare\(/g)?.length ?? 0), 0);
    expect(calls).toBe(1);
  });

  test("the store interface exposes one method, insert", () => {
    const storage = sources.find((s) => s.file === "core/storage.ts")!.text;
    const iface = /export interface FeedbackStore \{([\s\S]*?)\n\}/.exec(storage)![1]!;
    const methods = [...iface.matchAll(/^\s*([a-zA-Z_]\w*)\s*\(/gm)].map((m) => m[1]);
    expect(methods).toEqual(["insert"]);
  });

  test("the handler routes one path", () => {
    const handler = sources.find((s) => s.file === "core/handler.ts")!.text;
    const paths = [...new Set([...handler.matchAll(/["'`](\/[a-z][a-z0-9/_-]*)["'`]/g)].map((m) => m[1]))];
    expect(paths).toEqual(["/feedback"]);
  });

  test("nothing sets a cookie", () => {
    for (const { file, text } of sources) expect(/set-cookie/i.test(text), file).toBe(false);
  });
});
