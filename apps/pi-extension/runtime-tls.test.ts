/**
 * The runtime warning that replaced the package's Node engines floor (#902):
 * which runtimes lack the October 2026 TLS fixes, Bun judged as Bun, and at
 * most one warning per Pi start.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { runtimeTlsWarning, warnRuntimeTlsOnce } from "./runtime-tls.ts";

const WARNED = Symbol.for("plannotator.pi.runtimeTlsWarned");
const store = globalThis as Record<symbol, unknown>;
const saved = store[WARNED];

afterEach(() => {
	if (saved === undefined) delete store[WARNED];
	else store[WARNED] = saved;
});

describe("runtimeTlsWarning", () => {
	test("Node releases with the fixes get no warning", () => {
		for (const node of ["22.23.4", "22.30.0", "24.22.1", "24.23.0", "26.12.1", "26.13.0", "27.0.0", "30.1.2"]) {
			expect(runtimeTlsWarning({ node })).toBeNull();
		}
	});

	test("Node releases without them are named, with the versions to move to", () => {
		for (const node of ["18.20.4", "20.19.0", "22.23.3", "23.11.0", "24.15.0", "24.22.0", "25.2.1", "26.12.0"]) {
			expect(runtimeTlsWarning({ node })).toBe(
				`Plannotator: your Node v${node} is missing the Oct 21 TLS fixes (a compromised certificate authority); update to 22.23.4, 24.22.1 or 26.12.1 or later.`,
			);
		}
	});

	test("on Bun only Bun's version counts, whatever Node version it reports", () => {
		expect(runtimeTlsWarning({ bun: "1.4.4", node: "24.3.0" })).toBeNull();
		expect(runtimeTlsWarning({ bun: "1.5.0", node: "20.0.0" })).toBeNull();
		expect(runtimeTlsWarning({ bun: "1.3.14", node: "24.22.1" })).toContain("your Bun v1.3.14 is missing");
	});

	test("an unreadable version is not warned about", () => {
		expect(runtimeTlsWarning({ node: "" })).toBeNull();
		expect(runtimeTlsWarning({})).toBeNull();
	});
});

describe("warnRuntimeTlsOnce", () => {
	test("warns once per start, however many sessions or reloads follow", () => {
		delete store[WARNED];
		const shown: string[] = [];
		expect(warnRuntimeTlsOnce((m) => shown.push(m), { node: "24.15.0" })).toBe(true);
		expect(warnRuntimeTlsOnce((m) => shown.push(m), { node: "24.15.0" })).toBe(false);
		expect(shown).toHaveLength(1);
	});

	test("a fixed runtime shows nothing", () => {
		delete store[WARNED];
		const shown: string[] = [];
		expect(warnRuntimeTlsOnce((m) => shown.push(m), { node: "24.22.1" })).toBe(false);
		expect(shown).toEqual([]);
	});
});
