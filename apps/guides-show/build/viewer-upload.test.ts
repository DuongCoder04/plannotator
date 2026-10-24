import { describe, expect, test } from 'bun:test';
import { clampConcurrency, findMissing, publishViewer, RETRY_DELAYS_MS, runPool, uploadPlan, withRetry } from './viewer-upload';

const entries = { js: 'viewer.AAA.js', css: 'viewer.BBB.css' };
// readdirSync order on the runner that failed in v0.28.30: the entry JS came before most chunks.
const files = ['viewer.AAA.js', 'chunks/z.1.js', 'worker.W.js', 'viewer.BBB.css', 'chunks/a.2.js', 'fonts/x.woff2'];
const noWait = { sleep: async () => {} };

describe('uploadPlan', () => {
  test('every chunk and asset first, then the entry CSS, then the entry JS', () => {
    const plan = uploadPlan(files, entries);
    expect(plan.map((s) => s.rel)).toEqual(['chunks/a.2.js', 'chunks/z.1.js', 'fonts/x.woff2', 'worker.W.js', 'viewer.BBB.css', 'viewer.AAA.js']);
    expect(plan.map((s) => s.phase)).toEqual(['assets', 'assets', 'assets', 'assets', 'entry-css', 'entry-js']);
  });

  test('refuses a build without its entries', () => {
    expect(() => uploadPlan(['chunks/a.js', 'viewer.BBB.css'], entries)).toThrow(/viewer\.AAA\.js/);
  });
});

describe('withRetry', () => {
  test('retries with 1, 2, 4, 8 s waits and succeeds on the last attempt', async () => {
    const waits: number[] = [];
    let calls = 0;
    const out = await withRetry(async () => { if (++calls < 5) throw new Error('R2 500'); return 'ok'; }, { sleep: async (ms) => { waits.push(ms); } });
    expect(out).toBe('ok');
    expect(calls).toBe(5);
    expect(waits).toEqual([...RETRY_DELAYS_MS]);
    expect(waits).toEqual([1000, 2000, 4000, 8000]);
  });

  test('rethrows the last error once the attempts run out', async () => {
    let calls = 0;
    await expect(withRetry(async () => { calls++; throw new Error(`fail ${calls}`); }, noWait)).rejects.toThrow('fail 5');
    expect(calls).toBe(5);
  });

  test('does not wait after a success', async () => {
    const waits: number[] = [];
    await withRetry(async () => 1, { sleep: async (ms) => { waits.push(ms); } });
    expect(waits).toEqual([]);
  });
});

describe('runPool', () => {
  test('never runs more than the cap at once, and the cap is 4', async () => {
    let active = 0;
    let peak = 0;
    const seen: number[] = [];
    await runPool(Array.from({ length: 30 }, (_, i) => i), 16, async (i) => {
      active++; peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 1));
      seen.push(i); active--;
    });
    expect(peak).toBe(4);
    expect(seen.sort((a, b) => a - b)).toEqual(Array.from({ length: 30 }, (_, i) => i));
  });

  test('starts nothing new after a failure and throws it', async () => {
    const started: number[] = [];
    await expect(runPool([0, 1, 2, 3, 4, 5, 6, 7], 2, async (i) => {
      started.push(i);
      if (i === 1) throw new Error('boom');
      await new Promise((r) => setTimeout(r, 1));
    })).rejects.toThrow('boom');
    expect(started.length).toBeLessThan(8);
  });

  test('clampConcurrency keeps 1 to 4', () => {
    expect(clampConcurrency(0)).toBe(1);
    expect(clampConcurrency(2)).toBe(2);
    expect(clampConcurrency(9)).toBe(4);
    expect(clampConcurrency(Number.NaN)).toBe(4);
  });
});

describe('publishViewer', () => {
  const plan = uploadPlan(files, entries);

  test('entries go up only after every asset, then the manifest', async () => {
    const order: string[] = [];
    let assetsInFlight = 0;
    const uploaded = await publishViewer({
      steps: plan,
      concurrency: 4,
      put: async (rel) => {
        const isEntry = rel === entries.js || rel === entries.css;
        if (isEntry) expect(assetsInFlight).toBe(0);
        else assetsInFlight++;
        await new Promise((r) => setTimeout(r, 1));
        if (!isEntry) assetsInFlight--;
        order.push(rel);
      },
      putManifest: async () => { order.push('meta'); },
      retry: noWait,
    });
    expect(uploaded).toBe(files.length);
    expect(order.slice(-3)).toEqual([entries.css, entries.js, 'meta']);
    expect(new Set(order.slice(0, 4))).toEqual(new Set(['chunks/a.2.js', 'chunks/z.1.js', 'fonts/x.woff2', 'worker.W.js']));
  });

  test('a transient R2 500 is retried and the run succeeds', async () => {
    const tries = new Map<string, number>();
    const logs: string[] = [];
    await publishViewer({
      steps: plan,
      put: async (rel) => {
        const n = (tries.get(rel) ?? 0) + 1;
        tries.set(rel, n);
        if (rel === 'chunks/z.1.js' && n < 3) throw new Error('500 Internal Server Error');
      },
      putManifest: async () => {},
      retry: noWait,
      log: (l) => logs.push(l),
    });
    expect(tries.get('chunks/z.1.js')).toBe(3);
    expect(logs.filter((l) => l.includes('retrying chunks/z.1.js'))).toHaveLength(2);
  });

  test('a lasting failure on an asset stops the run before any entry or the manifest', async () => {
    const put: string[] = [];
    let manifest = false;
    await expect(publishViewer({
      steps: plan,
      concurrency: 1,
      put: async (rel) => { put.push(rel); if (rel === 'fonts/x.woff2') throw new Error('500'); },
      putManifest: async () => { manifest = true; },
      retry: noWait,
    })).rejects.toThrow(/upload failed for fonts\/x\.woff2 after 5 attempts/);
    expect(put).not.toContain(entries.css);
    expect(put).not.toContain(entries.js);
    expect(put.filter((r) => r === 'fonts/x.woff2')).toHaveLength(5);
    expect(manifest).toBe(false);
  });

  test('a lasting failure on the CSS never publishes the entry JS', async () => {
    const put: string[] = [];
    await expect(publishViewer({
      steps: plan,
      put: async (rel) => { put.push(rel); if (rel === entries.css) throw new Error('500'); },
      putManifest: async () => {},
      retry: noWait,
    })).rejects.toThrow(/viewer\.BBB\.css/);
    expect(put).not.toContain(entries.js);
  });
});

describe('findMissing', () => {
  test('HEADs every file under the base and lists the ones that are not 200', async () => {
    const asked: string[] = [];
    const missing = await findMissing({
      baseUrl: 'https://guides.show/v1',
      files: ['viewer.AAA.js', 'chunks/a.2.js', 'viewer.BBB.css'],
      head: async (url) => { asked.push(url); return url.endsWith('.css') ? 404 : 200; },
      retry: noWait,
    });
    expect(asked.filter((u) => u.endsWith('.js')).sort()).toEqual(['https://guides.show/v1/chunks/a.2.js', 'https://guides.show/v1/viewer.AAA.js']);
    expect(missing).toEqual(['viewer.BBB.css: HTTP 404']);
  });

  test('retries a network error before calling a file missing', async () => {
    let calls = 0;
    const missing = await findMissing({
      baseUrl: 'https://guides.show/v1/',
      files: ['viewer.AAA.js'],
      head: async () => { if (++calls < 2) throw new Error('ECONNRESET'); return 200; },
      retry: noWait,
    });
    expect(missing).toEqual([]);
    expect(calls).toBe(2);
  });
});
