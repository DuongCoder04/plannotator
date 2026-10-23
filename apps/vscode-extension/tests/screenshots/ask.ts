/**
 * Screenshots of "Ask the agent" in a real VS Code: a scratch `code serve-web`
 * (see make-fixture.ts; the FAKE agent answers with the fixture's ask turn),
 * driven in headless Chromium. It writes a guide, opens chapter 2's diff,
 * selects lines 25–31, and takes: the context menu, the question box, the
 * answer tab while the agent works, the drawn answer, and the chapter view's
 * answers. Manual check, not CI:
 *
 *   bun tests/screenshots/ask.ts <url> <out dir>
 *
 * Start serve-web with FAKE_AGENT_ASK_HOLD=6000 so the working state holds
 * long enough to be seen.
 */

import { chromium, type Frame, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

const [url, outDir] = process.argv.slice(2);
if (!url || !outDir) throw new Error("usage: ask.ts <url> <out dir>");
mkdirSync(outDir, { recursive: true });

const USER_SETTINGS = JSON.stringify({
  "security.workspace.trust.enabled": false,
  "workbench.startupEditor": "none",
  "workbench.colorTheme": process.env.SHOT_THEME === "light" ? "Default Light Modern" : "Default Dark Modern",
  "workbench.secondarySideBar.defaultVisibility": "hidden",
  "chat.disableAIFeatures": true,
  "workbench.tips.enabled": false,
  "editor.minimap.enabled": false,
  "diffEditor.codeLens": true,
  "diffEditor.renderSideBySide": false,
  "workbench.layoutControl.enabled": false,
  "window.commandCenter": true,
  "git.openRepositoryInParentFolders": "never",
  "extensions.ignoreRecommendations": true,
  "telemetry.telemetryLevel": "off",
}, null, 2);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function shot(page: Page, name: string): Promise<void> {
  const path = join(outDir, `${name}.png`);
  await page.screenshot({ path });
  console.log(`shot ${path}`);
}

async function command(page: Page, title: string): Promise<void> {
  await page.keyboard.press("Meta+Shift+P");
  const input = page.locator(".quick-input-widget input");
  await input.waitFor({ state: "visible", timeout: 10_000 });
  await input.fill(`>${title}`);
  await sleep(700);
  await page.keyboard.press("Enter");
}

async function webviewFrame(page: Page, selector: string, timeoutMs = 30_000): Promise<Frame> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    for (const frame of page.frames()) {
      try {
        if (await frame.locator(selector).count()) return frame;
      } catch {
        // detached
      }
    }
    await sleep(300);
  }
  throw new Error(`no webview shows ${selector}`);
}

async function quickInputVisible(page: Page): Promise<boolean> {
  return page.locator(".quick-input-widget").isVisible().catch(() => false);
}

let activePage: Page | null = null;

async function main(): Promise<void> {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1600, height: 960 }, deviceScaleFactor: 2, permissions: ["clipboard-read", "clipboard-write"] });
  const page = await context.newPage();
  activePage = page;
  page.on("console", (m) => {
    if (m.type() === "error") console.log(`[console] ${m.text().slice(0, 300)}`);
  });
  await page.goto(url);
  await page.locator(".monaco-workbench").waitFor({ timeout: 90_000 });
  await sleep(4000);
  await command(page, "Preferences: Open User Settings (JSON)");
  await sleep(2000);
  await page.evaluate((text) => navigator.clipboard.writeText(text), USER_SETTINGS);
  await page.keyboard.press("Meta+A");
  await page.keyboard.press("Meta+V");
  await sleep(500);
  await page.keyboard.press("Meta+S");
  await sleep(1000);
  await page.reload();
  await page.locator(".monaco-workbench").waitFor({ timeout: 90_000 });
  await sleep(5000);
  await page.keyboard.press("Meta+K");
  await page.keyboard.press("U");
  await sleep(800);
  await command(page, "View: Close Secondary Side Bar");
  await sleep(800);

  // Write a guide of the PR for this branch (the FAKE agent builds it).
  await page.locator('.activitybar [aria-label^="Guided Reviews"]').first().click();
  await sleep(2500);
  await command(page, "Guided Reviews: New Guided Review");
  for (let i = 0; i < 8; i++) {
    await page.locator(".quick-input-widget").waitFor({ state: "visible", timeout: 30_000 }).catch(() => {});
    if (!(await quickInputVisible(page))) break;
    await sleep(1500);
    await page.keyboard.press("Enter");
    await sleep(1500);
    const gen = await webviewFrame(page, ".pn-gen", 1500).catch(() => null);
    if (gen) break;
  }
  await webviewFrame(page, ".pn-guide", 180_000);
  await sleep(2500);

  // Chapter 2's first file: deliver.ts.
  const guide = await webviewFrame(page, ".pn-guide", 30_000);
  await guide.locator(".pn-chapter").nth(1).click();
  await sleep(5000);
  // Close the Guide tab's group clutter: focus the diff, go to line 25, select 25–31.
  const modified = page.locator(".monaco-diff-editor .editor.modified, .monaco-diff-editor .modified-in-monaco-diff-editor").first();
  await modified.click({ position: { x: 300, y: 200 } });
  await page.keyboard.press("Control+G");
  await sleep(500);
  await page.keyboard.type("25");
  await page.keyboard.press("Enter");
  await sleep(400);
  await page.keyboard.press("Home");
  await page.keyboard.press("Home");
  for (let i = 0; i < 7; i++) await page.keyboard.press("Shift+ArrowDown");
  await sleep(600);
  const line = page.locator(".monaco-diff-editor .view-line", { hasText: "const attempt = job.attempt + 1;" }).last();
  const box = await line.boundingBox();
  if (!box) throw new Error("line 25 is not on screen");
  await page.mouse.click(box.x + 120, box.y + box.height / 2 + 20, { button: "right" });
  const item = page.locator(".context-view .monaco-menu .action-label", { hasText: "Ask the Agent About This…" });
  await item.waitFor({ timeout: 10_000 });
  await item.hover();
  await sleep(500);
  await shot(page, "1-context-menu");
  await item.click();

  await page.locator(".quick-input-widget").waitFor({ state: "visible" });
  await sleep(1200);
  await shot(page, "2-ask-box");
  await page.keyboard.press("Enter"); // "Why did this change?"

  const working = await webviewFrame(page, ".pn-answer-working", 60_000);
  await working.locator(".pn-act").nth(3).waitFor({ timeout: 30_000 }).catch(() => {});
  await sleep(1200);
  await shot(page, "3-working");

  const answer = await webviewFrame(page, ".pn-answer-frame", 90_000);
  await sleep(3000);
  void answer;
  await page.mouse.move(1590, 950);
  await shot(page, "4-answer");

  // The chapter view's ask box and answers.
  const chapter = await webviewFrame(page, ".pn-answers", 30_000);
  await chapter.locator(".pn-answer-row").first().hover();
  await sleep(600);
  await shot(page, "5-chapter-answers");

  // A link in the agent's page opens its code in the diff's group; a chapter link opens the chapter.
  const page2 = await webviewFrame(page, 'a[href="code:src/webhooks/deliver.ts#L25-L31"]', 30_000);
  await page.locator(".statusbar").click({ position: { x: 5, y: 5 } }).catch(() => {});
  await page2.locator('a[href="chapter:4"]').click();
  await webviewFrame(page, ".pn-side h2", 10_000);
  await sleep(2500);
  const chapterTitle = await page.locator(".pane-header", { hasText: "Chapter 4" }).count();
  console.log(`check chapter link: ${chapterTitle > 0 ? "ok" : "FAILED"}`);
  await page2.locator('[data-link="symbol:computeBackoff"] rect').click({ force: true });
  await sleep(3000);
  const tabs = await page.locator(".tab .label-name").allTextContents();
  console.log(`check symbol link (tabs): ${tabs.join(" | ")}`);
  await shot(page, "6-after-link");

  // A follow-up in the answer tab continues the conversation.
  const tab = await webviewFrame(page, ".pn-answer-foot .pn-ask-input", 10_000);
  await tab.locator(".pn-answer-foot .pn-ask-input").fill("Does the worker count attempts twice?");
  await tab.locator(".pn-answer-foot .pn-ask-input").press("Enter");
  await webviewFrame(page, ".pn-answer-prev", 30_000);
  await webviewFrame(page, ".pn-answer-frame", 60_000);
  await sleep(2500);
  await shot(page, "7-follow-up");

  await browser.close();
}

main().catch(async (err) => {
  console.error(err);
  if (activePage) await activePage.screenshot({ path: join(outDir, "error.png") }).catch(() => {});
  process.exit(1);
});
