/**
 * The webviews draw Mermaid with the reader build's `diagram.js`, imported
 * from the URL the host puts on the body; without one, a diagram stays as its
 * source (a failure, never a throw).
 */
import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const hasDom = typeof document !== "undefined";
const dir = mkdtempSync(join(tmpdir(), "pn-diagram-loader-"));
afterEach(() => {
  if (hasDom) delete document.body.dataset.pnDiagram;
});

describe.skipIf(!hasDom)("the webviews' diagram engine, loaded when a diagram is drawn", () => {
  it("is imported from the host's URL, once", async () => {
    const mod = join(dir, "diagram.mjs");
    writeFileSync(mod, `globalThis.__loads = (globalThis.__loads ?? 0) + 1;
export async function renderMermaid(source) { return { ok: false, message: "drawn " + source, line: null }; }
export async function checkMermaid(source) { return { ok: true }; }`);
    document.body.dataset.pnDiagram = pathToFileURL(mod).href;
    const { renderMermaid, checkMermaid } = await import("./diagram-loader");
    expect(await renderMermaid("graph TD; A-->B")).toEqual({ ok: false, message: "drawn graph TD; A-->B", line: null });
    expect(await checkMermaid("graph TD; A-->B")).toEqual({ ok: true });
    expect((globalThis as { __loads?: number }).__loads).toBe(1);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe.skipIf(!hasDom)("without the engine", () => {
  it("a diagram is a failure, not a throw", async () => {
    // A fresh copy of the module (no cached load).
    const fresh = (await import(`./diagram-loader?fresh=${Date.now()}`)) as typeof import("./diagram-loader");
    const r = await fresh.renderMermaid("graph TD; A-->B");
    expect(r.ok).toBe(false);
    expect((await fresh.checkMermaid("x")).ok).toBe(false);
  });
});
