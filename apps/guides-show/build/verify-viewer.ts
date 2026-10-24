/// <reference types="bun-types" />
/**
 * Check that a published viewer is whole on the live site.
 *   bun build/verify-viewer.ts [--base https://guides.show/v1/]
 *
 * HEADs every file of the local build (dist/viewer: the entry JS and CSS, the
 * worker, every chunks/ file and asset) under the base URL and fails when any
 * does not answer 200, then checks the entry JS carries the immutable cache and
 * open CORS headers exported guides rely on. Read only: it never writes.
 * Run after deploy:viewer, so a partial publish fails the workflow.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import type { ViewerManifest } from './manifest-plugin';
import { findMissing } from './viewer-upload';

const args = process.argv.slice(2);
const opt = (name: string, dflt: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : dflt; };
const base = opt('--base', 'https://guides.show/v1/');
const dist = path.resolve(import.meta.dirname, '../dist/viewer');
const manifest = JSON.parse(readFileSync(path.join(dist, 'manifest.json'), 'utf8')) as ViewerManifest;

function walk(dir: string, prefix = ''): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    const rel = prefix ? `${prefix}/${entry}` : entry;
    if (statSync(full).isDirectory()) out.push(...walk(full, rel));
    else out.push(rel);
  }
  return out;
}

const files = walk(dist).filter((f) => f !== 'manifest.json');
// The manifest names what exported guides load; each must be in the build.
for (const rel of [manifest.js, manifest.css, ...Object.values(manifest.langs)]) {
  if (!files.includes(rel)) { console.error(`manifest names ${rel}, which is not in dist/viewer`); process.exit(1); }
}

console.log(`checking ${files.length} files under ${base}`);
const head = async (url: string) => (await fetch(url, { method: 'HEAD', redirect: 'manual' })).status;
const missing = await findMissing({ baseUrl: base, files, head, retry: { delaysMs: [1000, 2000, 4000] } });
if (missing.length > 0) {
  console.error(`${missing.length} of ${files.length} viewer files are not published:\n${missing.map((m) => `  ${m}`).join('\n')}`);
  process.exit(1);
}

const entryUrl = `${base.endsWith('/') ? base : `${base}/`}${manifest.js}`;
const res = await fetch(entryUrl, { method: 'HEAD' });
const problems: string[] = [];
if (!/public, max-age=31536000, immutable/i.test(res.headers.get('cache-control') ?? '')) problems.push(`cache-control is "${res.headers.get('cache-control')}"`);
if (res.headers.get('access-control-allow-origin') !== '*') problems.push(`access-control-allow-origin is "${res.headers.get('access-control-allow-origin')}"`);
if (problems.length > 0) { console.error(`${entryUrl}: ${problems.join('; ')}`); process.exit(1); }

console.log(`all ${files.length} viewer files are published; ${manifest.js} has the immutable cache and CORS headers`);
