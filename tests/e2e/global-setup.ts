/**
 * Before any spec: never the live feedback Worker (its table is append-only).
 * Every spec and every binary started with this env sends feedback to a
 * closed loopback port (tests/setup/feedback-archive-off.ts). Playwright
 * hands this process.env to its workers.
 */
export default function globalSetup(): void {
  process.env.PLANNOTATOR_FEEDBACK_URL = 'http://127.0.0.1:9/feedback';
}
