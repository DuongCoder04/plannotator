/**
 * No package Plannotator can publish may carry a field that makes an installer
 * skip a release and install an older one without an error.
 *
 * 0.28.32 added `engines.node` to @plannotator/pi-extension. For a bare name
 * or a range (`pi install npm:@plannotator/pi-extension`, a saved `^0.28.31`)
 * npm-pick-manifest passes over every version whose `engines.node` or
 * `engines.npm` the running runtime misses, and over deprecated ones, then
 * installs the newest that's left: Pi on an older Node stayed at 0.28.31 for
 * every later release (#902). `os`, `cpu` and `libc` do the same through
 * npm-install-checks. This scans every package.json that isn't
 * `"private": true` (npm refuses to publish those, so the rest is everything
 * publishable, including @plannotator/ui and @plannotator/core, which are on
 * npm but are not published by release.yml) and fails on:
 *
 * - `engines.node`, `engines.npm`: read by npm and by Arborist, which OpenCode
 *   installs plugins with (Arborist defaults `nodeVersion` to process.version,
 *   which Bun reports too);
 * - `engines.opencode`: nothing reads it today, but a host check added later
 *   would pin installs the same way;
 * - `os`, `cpu`, `libc`;
 * - a peerDependency on the OpenCode package (OpenCode installs the plugin
 *   with Arborist into its own cache, so the peer is resolved there against
 *   the host's own copy) or on Pi under any scope but `@earendil-works/pi-*`
 *   (the old `@mariozechner` scope would pull or clash with a second Pi).
 *
 * `engines.bun` (the OpenCode plugin) stays allowed: OpenCode installs plugins
 * with `@npmcli/arborist` (`reify` in packages/core/src/npm.ts in 1.x,
 * packages/util/src/npm.ts in 2.x), whose version pick checks only
 * `engines.node` and `engines.npm`, and nothing in OpenCode reads `engines`
 * from a plugin's manifest.
 *
 * A gated field that's truly wanted needs an entry in ALLOWED with the exact
 * value and the reason, signed off by the owner knowing it can freeze
 * installs. A changed value fails again, and an entry nothing matches fails
 * until it is removed.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
	type FloorAllowance,
	findPublishablePackages,
	staleAllowances,
	updateBlockingFields,
} from "./helpers/published-packages";

const repoRoot = resolve(import.meta.dir, "..");

const ALLOWED: readonly FloorAllowance[] = [];

const packages = findPublishablePackages(repoRoot);

describe("published packages carry no field that blocks updates", () => {
	for (const { path, manifest } of packages) {
		test(path, () => {
			expect(updateBlockingFields(manifest, ALLOWED)).toEqual([]);
		});
	}

	test("every allowance still matches a field exactly", () => {
		expect(staleAllowances(packages, ALLOWED)).toEqual([]);
	});

	// The scan is only as good as its package list: if discovery missed a
	// folder, the per-package tests above would silently not run for it.
	test("the scan covers every package release.yml packs for npm", () => {
		const workflow = readFileSync(join(repoRoot, ".github/workflows/release.yml"), "utf8");
		const packed = [...workflow.matchAll(/working-directory:\s*(\S+)\s*\n\s*run:\s*bun pm pack\b/g)].map(
			(match) => `${match[1]}/package.json`,
		);
		expect(packed.length).toBeGreaterThanOrEqual(2);
		const scanned = packages.map((pkg) => pkg.path);
		for (const path of packed) expect(scanned).toContain(path);
	});

	// The root manifest has a `bin` and the name `plannotator`, which nobody
	// owns on npm: a stray `npm publish` at the root would claim it with a
	// package that can't run.
	test("the root package.json stays private", () => {
		const root = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as { private?: boolean };
		expect(root.private).toBe(true);
	});
});

describe("the floor check catches each gated field", () => {
	const name = "@plannotator/example";
	const fields = (manifest: object, allowlist: readonly FloorAllowance[] = []) =>
		updateBlockingFields({ name, ...manifest }, allowlist).map((finding) => finding.field);

	test("engines.node, engines.npm and engines.opencode", () => {
		expect(fields({ engines: { node: ">=22", npm: ">=10", opencode: ">=1" } })).toEqual([
			"engines.node",
			"engines.npm",
			"engines.opencode",
		]);
	});

	test("os, cpu and libc", () => {
		expect(fields({ os: ["darwin"], cpu: ["arm64"], libc: ["glibc"] })).toEqual(["os", "cpu", "libc"]);
	});

	test("engines.bun and engines.vscode pass", () => {
		expect(fields({ engines: { bun: ">=1.4.4", vscode: "^1.85.0" } })).toEqual([]);
	});

	test("an OpenCode peer under any of its names", () => {
		expect(
			fields({
				peerDependencies: { "@opencode-ai/plugin": "*", "@opencode/cli": "*", "opencode-ai": "*", react: "^19" },
			}),
		).toEqual(["peerDependencies.@opencode-ai/plugin", "peerDependencies.@opencode/cli", "peerDependencies.opencode-ai"]);
	});

	test("a Pi peer outside @earendil-works/pi-*", () => {
		expect(
			fields({
				peerDependencies: {
					"@earendil-works/pi-coding-agent": ">=0.79.1",
					"@mariozechner/pi-coding-agent": ">=0.60.0",
					"pi-coding-agent": "*",
				},
			}),
		).toEqual(["peerDependencies.@mariozechner/pi-coding-agent", "peerDependencies.pi-coding-agent"]);
	});

	test("an allowance admits only its exact value", () => {
		const allowance: FloorAllowance = { package: name, field: "engines.node", value: ">=22", reason: "test" };
		expect(fields({ engines: { node: ">=22" } }, [allowance])).toEqual([]);
		expect(fields({ engines: { node: ">=24" } }, [allowance])).toEqual(["engines.node"]);
		expect(fields({ engines: { node: ">=22", npm: ">=10" } }, [allowance])).toEqual(["engines.npm"]);
	});

	test("an allowance that matches nothing is reported", () => {
		const allowance: FloorAllowance = { package: name, field: "os", value: ["linux"], reason: "test" };
		const published = [{ path: "x/package.json", manifest: { name, os: ["darwin"] } }];
		expect(staleAllowances(published, [allowance])).toEqual([allowance]);
	});
});
