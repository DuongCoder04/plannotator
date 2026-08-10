/**
 * Rendering-neutrality contract for the HTML viewer (see srcdoc.ts).
 *
 * Arbitrary customer HTML must render exactly as in a plain browser tab: the
 * viewer writes NOTHING into the document's namespace — no bare CSS custom
 * properties (a host `--muted` clobbering an author `--muted` visibly corrupts
 * documents), no `color-scheme`, no root classes, no styling of author
 * elements. Host tokens travel only under the viewer-owned `--pn-*` prefix
 * unless the document opts in via <meta name="plannotator-theme" content="host">.
 *
 * These tests are the mutation guard: reintroducing any bare-token injection
 * for non-opted-in documents must go red here.
 */
import { beforeAll, describe, expect, test } from "bun:test";
import { ANNOTATION_HIGHLIGHT_CSS, BRIDGE_SCRIPT } from "./bridge-script";
import {
  DIFF_HIGHLIGHT_CSS,
  buildSrcdocInjection,
  buildThemeTokenPayload,
  hasHostThemeOptIn,
  injectIntoHead,
} from "./srcdoc";

const HOST_TOKENS = {
  "--background": "oklch(0.15 0.02 260)",
  "--muted": "oklch(0.26 0.02 260)",
  "--border": "oklch(0.35 0.02 260)",
  "--destructive": "oklch(0.65 0.20 25)",
  "--focus-highlight": "#4493f8",
};

/** Matches a bare (non --pn-) custom-property declaration like `--muted:`. */
const BARE_TOKEN_DECL = /(^|[^-\w])--(?!pn-)[\w-]+\s*:/m;

describe("buildThemeTokenPayload", () => {
  test("default (arbitrary document): every pushed property is --pn- prefixed", () => {
    const payload = buildThemeTokenPayload(HOST_TOKENS, false);
    expect(Object.keys(payload).length).toBe(Object.keys(HOST_TOKENS).length);
    for (const key of Object.keys(payload)) {
      expect(key.startsWith("--pn-")).toBe(true);
    }
    expect(payload["--pn-muted"]).toBe(HOST_TOKENS["--muted"]);
    expect(payload["--muted"]).toBeUndefined();
  });

  test("host-theme opt-in: bare tokens ride along with the --pn- set", () => {
    const payload = buildThemeTokenPayload(HOST_TOKENS, true);
    expect(payload["--muted"]).toBe(HOST_TOKENS["--muted"]);
    expect(payload["--pn-muted"]).toBe(HOST_TOKENS["--muted"]);
  });
});

describe("buildSrcdocInjection", () => {
  const base = { tokens: HOST_TOKENS, isLight: true, hostTheme: false, diffActive: false };

  test("arbitrary document: no bare custom-property declarations reach the doc", () => {
    const injection = buildSrcdocInjection(base);
    const [themeBlock] = injection.split(ANNOTATION_HIGHLIGHT_CSS);
    expect(themeBlock).toContain("--pn-muted:");
    expect(BARE_TOKEN_DECL.test(themeBlock!.replace(/--pn-[\w-]+\s*:/g, ""))).toBe(false);
  });

  test("arbitrary document: no color-scheme injection in either host theme", () => {
    expect(buildSrcdocInjection({ ...base, isLight: true })).not.toContain("color-scheme");
    expect(buildSrcdocInjection({ ...base, isLight: false })).not.toContain("color-scheme");
  });

  test("host-theme opt-in: bare tokens and symmetric color-scheme are injected", () => {
    const light = buildSrcdocInjection({ ...base, hostTheme: true, isLight: true });
    expect(light).toContain("--muted:");
    expect(light).toContain("color-scheme: light");
    const dark = buildSrcdocInjection({ ...base, hostTheme: true, isLight: false });
    expect(dark).toContain("color-scheme: dark");
  });

  test("diff CSS is absent on plain renders and scoped when active", () => {
    expect(buildSrcdocInjection(base)).not.toContain("plannotator-diff");
    const active = buildSrcdocInjection({ ...base, diffActive: true });
    expect(active).toContain(DIFF_HIGHLIGHT_CSS);
    // Scoped to diff-generated markup only — never bare ins/del selectors that
    // would restyle author elements.
    expect(DIFF_HIGHLIGHT_CSS).toContain("ins.plannotator-diff");
    expect(DIFF_HIGHLIGHT_CSS).toContain("del.plannotator-diff");
    expect(/(^|[}\s;])(ins|del)\s*\{/.test(DIFF_HIGHLIGHT_CSS)).toBe(false);
  });
});

describe("viewer CSS/script namespace", () => {
  test("annotation CSS reads only --pn- variables", () => {
    expect(ANNOTATION_HIGHLIGHT_CSS).toContain("var(--pn-");
    expect(/var\(--(?!pn-)/.test(ANNOTATION_HIGHLIGHT_CSS)).toBe(false);
    expect(ANNOTATION_HIGHLIGHT_CSS).toContain("[data-plannotator-vim-reticle]");
    expect(ANNOTATION_HIGHLIGHT_CSS).toContain("@media (prefers-reduced-motion: reduce)");
    expect(BRIDGE_SCRIPT).toContain("return 'PREVIOUS BLOCK'");
    expect(BRIDGE_SCRIPT).toContain("return 'NEXT BLOCK'");
    expect(BRIDGE_SCRIPT).toContain("return 'SWAPPED ENDS'");
  });

  test("bridge script reads only --pn- variables and guards bare writes", () => {
    expect(/var\(--(?!pn-)/.test(BRIDGE_SCRIPT)).toBe(false);
    // The theme handler's non-opt-in guard: only --pn-* may be set on the root.
    expect(BRIDGE_SCRIPT).toContain("key.indexOf('--pn-') !== 0");
  });
});

describe("hasHostThemeOptIn", () => {
  test("detects the meta tag across attribute order and quoting", () => {
    expect(
      hasHostThemeOptIn('<head><meta name="plannotator-theme" content="host"></head>'),
    ).toBe(true);
    expect(
      hasHostThemeOptIn("<head><meta content='host' name='plannotator-theme'/></head>"),
    ).toBe(true);
    expect(hasHostThemeOptIn("<head><meta name=plannotator-theme content=host></head>")).toBe(
      true,
    );
  });

  test("does not trigger on absent, foreign, or mismatched metas", () => {
    expect(hasHostThemeOptIn("<html><body><p>hi</p></body></html>")).toBe(false);
    expect(hasHostThemeOptIn('<meta name="viewport" content="host">')).toBe(false);
    expect(hasHostThemeOptIn('<meta name="plannotator-theme" content="self">')).toBe(false);
  });
});

// Exercises the real bridge theme handler (the inline-setProperty site): on a
// host theme flip, nothing may land on the author's documentElement except
// --pn-* properties — no bare tokens, no `light` class — unless the document
// opted in to host theming. Requires DOM_TESTS=1 (happy-dom preload).
const hasDom = typeof document !== "undefined";
describe.if(hasDom)("bridge theme handler (DOM)", () => {
  function bridgeMessageData(event: MessageEvent): Record<string, unknown> | null {
    if (!event.data || typeof event.data !== "object") return null;
    return event.data instanceof Object
      ? Object.fromEntries(Object.entries(event.data))
      : null;
  }

  beforeAll(() => {
    new Function(BRIDGE_SCRIPT)();
  });

  function postBridge(data: Record<string, unknown>) {
    window.dispatchEvent(
      new MessageEvent("message", {
        data,
        source: window,
      }),
    );
  }

  test("author root only receives --pn-* on theme flip; opt-in restores bare push", () => {
    const root = document.documentElement;

    postBridge({
      type: "plannotator-bridge-theme",
      tokens: { "--pn-muted": "red", "--muted": "blue" },
      isLight: true,
      hostTheme: false,
    });
    expect(root.style.getPropertyValue("--pn-muted")).toBe("red");
    expect(root.style.getPropertyValue("--muted")).toBe("");
    expect(root.classList.contains("light")).toBe(false);

    postBridge({
      type: "plannotator-bridge-theme",
      tokens: { "--pn-muted": "red", "--muted": "blue" },
      isLight: true,
      hostTheme: true,
    });
    expect(root.style.getPropertyValue("--muted")).toBe("blue");
    expect(root.classList.contains("light")).toBe(true);

    root.style.removeProperty("--pn-muted");
    root.style.removeProperty("--muted");
    root.classList.remove("light");
  });

  test("Vim navigation is block-first, focus-safe, and posts through the normal selection protocol", async () => {
    document.body.innerHTML = [
      "<h1>Keyboard document</h1>",
      "<p>First paragraph</p>",
      "<p>Second paragraph</p>",
      '<a href="#destination">Native link</a>',
      '<input value="native typing">',
    ].join("");

    postBridge({
      type: "plannotator-bridge-set-input-method",
      method: "pinpoint",
    });
    postBridge({
      type: "plannotator-bridge-set-vim-mode",
      enabled: false,
    });

    const disabledMove = new KeyboardEvent("keydown", {
      key: "j",
      bubbles: true,
      cancelable: true,
    });
    document.body.dispatchEvent(disabledMove);
    expect(disabledMove.defaultPrevented).toBe(false);
    expect(document.querySelector("[data-plannotator-vim-badge]")).toBeNull();

    postBridge({
      type: "plannotator-bridge-set-vim-mode",
      enabled: true,
    });
    postBridge({
      type: "plannotator-bridge-focus-vim",
    });
    expect(document.body.getAttribute("tabindex")).toBe("-1");
    expect(document.body.hasAttribute("data-plannotator-vim-focus-owner")).toBe(true);
    const initial = document.querySelector(".plannotator-pinpoint-hover");
    expect(initial?.textContent).toBe("Keyboard document");
    expect(document.querySelector("[data-plannotator-vim-badge]")?.textContent)
      .toBe("BLOCK · PINPOINT");

    const tab = new KeyboardEvent("keydown", {
      key: "Tab",
      bubbles: true,
      cancelable: true,
    });
    document.body.dispatchEvent(tab);
    expect(tab.defaultPrevented).toBe(false);
    expect(document.querySelector(".plannotator-pinpoint-hover")?.textContent)
      .toBe("Keyboard document");

    const move = new KeyboardEvent("keydown", {
      key: "j",
      bubbles: true,
      cancelable: true,
    });
    document.body.dispatchEvent(move);
    expect(move.defaultPrevented).toBe(true);
    expect(document.querySelector(".plannotator-pinpoint-hover")?.textContent)
      .toBe("First paragraph");

    const bridgeMessages: Array<Record<string, unknown>> = [];
    const capture = (event: MessageEvent) => {
      const data = bridgeMessageData(event);
      if (data?.type === "plannotator-bridge-selection") bridgeMessages.push(data);
    };
    window.addEventListener("message", capture);
    const comment = new KeyboardEvent("keydown", {
      key: "c",
      bubbles: true,
      cancelable: true,
    });
    document.body.dispatchEvent(comment);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    window.removeEventListener("message", capture);
    expect(comment.defaultPrevented).toBe(true);
    expect(bridgeMessages.at(-1)).toMatchObject({
      type: "plannotator-bridge-selection",
      text: "First paragraph",
      modeOverride: "comment",
    });

    const input = document.querySelector<HTMLInputElement>("input");
    if (!input) throw new Error("Missing bridge input fixture");
    const typing = new KeyboardEvent("keydown", {
      key: "d",
      bubbles: true,
      cancelable: true,
    });
    input.dispatchEvent(typing);
    expect(typing.defaultPrevented).toBe(false);

    const link = document.querySelector<HTMLAnchorElement>("a");
    if (!link) throw new Error("Missing bridge link fixture");
    const activateLink = new KeyboardEvent("keydown", {
      key: "Enter",
      bubbles: true,
      cancelable: true,
    });
    link.dispatchEvent(activateLink);
    expect(activateLink.defaultPrevented).toBe(false);

    postBridge({
      type: "plannotator-bridge-cancel-selection",
    });
    document.body.innerHTML = [
      "<table><tbody>",
      "<tr><td>A1</td><td>A2</td></tr>",
      "<tr><td>B1</td><td>B2</td></tr>",
      "</tbody></table>",
      "<p>After table</p>",
    ].join("");
    postBridge({
      type: "plannotator-bridge-set-input-method",
      method: "pinpoint",
    });
    for (const key of ["l", "l"]) {
      document.body.dispatchEvent(new KeyboardEvent("keydown", {
        key,
        bubbles: true,
        cancelable: true,
      }));
    }
    const a1 = document.querySelector(".plannotator-pinpoint-hover");
    expect(a1?.tagName).toBe("TD");
    expect(a1?.textContent).toBe("A1");
    document.body.dispatchEvent(new KeyboardEvent("keydown", {
      key: "j",
      bubbles: true,
      cancelable: true,
    }));
    expect(document.querySelector(".plannotator-pinpoint-hover")?.textContent).toBe("A2");
    document.body.dispatchEvent(new KeyboardEvent("keydown", {
      key: "h",
      bubbles: true,
      cancelable: true,
    }));
    expect(document.querySelector(".plannotator-pinpoint-hover")?.tagName).toBe("TR");
    document.body.dispatchEvent(new KeyboardEvent("keydown", {
      key: "j",
      bubbles: true,
      cancelable: true,
    }));
    expect(document.querySelector(".plannotator-pinpoint-hover")?.textContent).toBe("B1B2");
    document.body.dispatchEvent(new KeyboardEvent("keydown", {
      key: "h",
      bubbles: true,
      cancelable: true,
    }));
    expect(document.querySelector(".plannotator-pinpoint-hover")?.tagName).toBe("TABLE");
    document.body.dispatchEvent(new KeyboardEvent("keydown", {
      key: "j",
      bubbles: true,
      cancelable: true,
    }));
    expect(document.querySelector(".plannotator-pinpoint-hover")?.textContent)
      .toBe("After table");

    postBridge({
      type: "plannotator-bridge-set-vim-mode",
      enabled: false,
    });
    document.body.innerHTML = "<p>Alpha <strong>bravo</strong> charlie</p>";
    postBridge({
      type: "plannotator-bridge-set-vim-mode",
      enabled: true,
    });
    postBridge({
      type: "plannotator-bridge-focus-vim",
    });
    document.body.dispatchEvent(new KeyboardEvent("keydown", {
      key: "l",
      bubbles: true,
      cancelable: true,
    }));
    expect(document.querySelector(".plannotator-pinpoint-hover")?.tagName).toBe("STRONG");
    document.body.dispatchEvent(new KeyboardEvent("keydown", {
      key: "v",
      bubbles: true,
      cancelable: true,
    }));
    for (const key of ["w", "e"]) {
      document.body.dispatchEvent(new KeyboardEvent("keydown", {
        key,
        bubbles: true,
        cancelable: true,
      }));
      expect(window.getSelection()?.toString()).toBe("bravo");
    }

    postBridge({
      type: "plannotator-bridge-set-vim-mode",
      enabled: false,
    });
    document.body.innerHTML = "<p>Alpha bravo charlie</p>";
    postBridge({
      type: "plannotator-bridge-set-input-method",
      method: "drag",
    });
    postBridge({
      type: "plannotator-bridge-set-vim-mode",
      enabled: true,
    });
    postBridge({
      type: "plannotator-bridge-focus-vim",
    });
    const visual = new KeyboardEvent("keydown", {
      key: "v",
      bubbles: true,
      cancelable: true,
    });
    document.body.dispatchEvent(visual);
    const word = new KeyboardEvent("keydown", {
      key: "w",
      bubbles: true,
      cancelable: true,
    });
    document.body.dispatchEvent(word);
    expect(window.getSelection()?.toString()).toBe("Alpha ");
    const action = new KeyboardEvent("keydown", {
      key: " ",
      bubbles: true,
      cancelable: true,
    });
    document.body.dispatchEvent(action);
    expect(document.querySelector("[data-plannotator-vim-badge]")?.textContent)
      .toBe("ACTION · SELECT");

    postBridge({
      type: "plannotator-bridge-cancel-selection",
    });
    expect(document.querySelector("[data-plannotator-vim-badge]")?.textContent)
      .toBe("VISUAL · SELECT");
    expect(window.getSelection()?.toString()).toBe("Alpha ");

    postBridge({
      type: "plannotator-bridge-set-vim-mode",
      enabled: false,
    });
    document.body.innerHTML = "<p>Collapsed text target</p>";
    postBridge({
      type: "plannotator-bridge-set-vim-mode",
      enabled: true,
    });
    postBridge({
      type: "plannotator-bridge-focus-vim",
    });
    document.body.dispatchEvent(new KeyboardEvent("keydown", {
      key: "l",
      bubbles: true,
      cancelable: true,
    }));
    const collapsedAction = new KeyboardEvent("keydown", {
      key: "c",
      bubbles: true,
      cancelable: true,
    });
    document.body.dispatchEvent(collapsedAction);
    expect(collapsedAction.defaultPrevented).toBe(false);
    const collapsedCopy = new KeyboardEvent("keydown", {
      key: "y",
      bubbles: true,
      cancelable: true,
    });
    document.body.dispatchEvent(collapsedCopy);
    expect(collapsedCopy.defaultPrevented).toBe(false);
    expect(document.querySelector("[data-plannotator-vim-badge]")?.textContent)
      .toBe("NORMAL · SELECT");
    document.body.dispatchEvent(new KeyboardEvent("keydown", {
      key: "Escape",
      bubbles: true,
      cancelable: true,
    }));
    document.body.dispatchEvent(new KeyboardEvent("keydown", {
      key: "Escape",
      bubbles: true,
      cancelable: true,
    }));
    const inactiveEscape = new KeyboardEvent("keydown", {
      key: "Escape",
      bubbles: true,
      cancelable: true,
    });
    document.body.dispatchEvent(inactiveEscape);
    expect(inactiveEscape.defaultPrevented).toBe(false);

    postBridge({
      type: "plannotator-bridge-set-vim-mode",
      enabled: false,
    });
    document.body.innerHTML = "<p>Block one</p><p>Block two</p>";
    postBridge({
      type: "plannotator-bridge-set-vim-mode",
      enabled: true,
    });
    postBridge({
      type: "plannotator-bridge-focus-vim",
    });
    for (const key of ["V", "j"]) {
      document.body.dispatchEvent(new KeyboardEvent("keydown", {
        key,
        bubbles: true,
        cancelable: true,
      }));
    }
    expect(window.getSelection()?.toString()).toContain("Block two");
    document.body.dispatchEvent(new KeyboardEvent("keydown", {
      key: "k",
      bubbles: true,
      cancelable: true,
    }));
    expect(window.getSelection()?.toString()).toBe("Block one");

    postBridge({
      type: "plannotator-bridge-set-vim-mode",
      enabled: false,
    });
    expect(document.body.hasAttribute("tabindex")).toBe(false);
    document.body.replaceChildren();
  });

  test("Vim HUD mode suppresses the iframe badge and emits handled command DTOs", async () => {
    document.body.innerHTML = "<h1>First block</h1><p>Second block</p>";
    const hudMessages: Array<Record<string, unknown>> = [];
    const capture = (event: MessageEvent) => {
      const data = bridgeMessageData(event);
      if (
        data
        && [
          "plannotator-bridge-vim-command",
          "plannotator-bridge-vim-state",
          "plannotator-bridge-vim-help",
        ]
          .includes(typeof data.type === "string" ? data.type : "")
      ) {
        hudMessages.push(data);
      }
    };
    window.addEventListener("message", capture);

    postBridge({
      type: "plannotator-bridge-set-vim-mode",
      enabled: true,
      hudEnabled: false,
    });
    postBridge({ type: "plannotator-bridge-focus-vim" });
    document.body.dispatchEvent(new KeyboardEvent("keydown", {
      key: "j",
      bubbles: true,
      cancelable: true,
    }));
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(hudMessages).toEqual([]);
    expect(document.querySelector("[data-plannotator-vim-badge]")).not.toBeNull();

    postBridge({
      type: "plannotator-bridge-set-vim-mode",
      enabled: false,
    });
    document.body.innerHTML = "<h1>First block</h1><p>Second block</p>";
    postBridge({
      type: "plannotator-bridge-set-input-method",
      method: "pinpoint",
    });
    postBridge({
      type: "plannotator-bridge-set-vim-mode",
      enabled: true,
      hudEnabled: true,
    });
    postBridge({ type: "plannotator-bridge-focus-vim" });
    document.body.dispatchEvent(new KeyboardEvent("keydown", {
      key: "j",
      bubbles: true,
      cancelable: true,
    }));
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    expect(document.querySelector("[data-plannotator-vim-badge]")).toBeNull();
    expect(hudMessages).toContainEqual({
      type: "plannotator-bridge-vim-state",
      phase: "block",
    });
    expect(hudMessages).toContainEqual({
      type: "plannotator-bridge-vim-command",
      actionId: "moveDown",
      key: "j",
      context: "block",
    });
    const reticle = document.querySelector<HTMLElement>(
      "[data-plannotator-vim-reticle]",
    );
    expect(reticle).not.toBeNull();
    expect(reticle?.dataset.vimTargetPhase).toBe("block");
    expect(reticle?.dataset.vimTargetLabel).toBe("BLOCK · PARAGRAPH");
    expect(reticle?.querySelectorAll("[data-vim-reticle-corner]")).toHaveLength(4);
    expect(document.querySelector(".plannotator-pinpoint-hover")).toBeNull();

    document.body.dispatchEvent(new KeyboardEvent("keydown", {
      key: "?",
      bubbles: true,
      cancelable: true,
    }));
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(hudMessages).toContainEqual({
      type: "plannotator-bridge-vim-help",
      open: true,
    });
    expect(document.querySelector("[data-plannotator-vim-help]")).toBeNull();

    postBridge({
      type: "plannotator-bridge-set-vim-help",
      open: false,
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(hudMessages).toContainEqual({
      type: "plannotator-bridge-vim-help",
      open: false,
    });

    document.body.dispatchEvent(new KeyboardEvent("keydown", {
      key: "l",
      bubbles: true,
      cancelable: true,
    }));
    expect(reticle?.dataset.vimTargetPhase).toBe("text");
    expect(reticle?.dataset.vimTargetLabel).toBe("CURSOR · INLINE TEXT");

    for (const key of ["v", "e"]) {
      document.body.dispatchEvent(new KeyboardEvent("keydown", {
        key,
        bubbles: true,
        cancelable: true,
      }));
    }
    expect(reticle?.dataset.vimTargetPhase).toBe("visual");
    expect(reticle?.dataset.vimTargetLabel).toBe("VISUAL · EXACT TOKEN");

    postBridge({
      type: "plannotator-bridge-set-vim-mode",
      enabled: false,
    });
    window.removeEventListener("message", capture);
    document.body.replaceChildren();
  });

  test("routes Vim yank text to the trusted parent without sandbox clipboard access", async () => {
    document.body.innerHTML = "<h1>Keyboard review fixture</h1><p>After</p>";
    const copyMessages: Array<Record<string, unknown>> = [];
    const capture = (event: MessageEvent) => {
      const data = bridgeMessageData(event);
      if (data?.type === "plannotator-bridge-vim-copy") {
        copyMessages.push(data);
      }
    };
    window.addEventListener("message", capture);

    postBridge({
      type: "plannotator-bridge-set-vim-mode",
      enabled: true,
      hudEnabled: true,
    });
    postBridge({ type: "plannotator-bridge-focus-vim" });
    for (const key of ["V", "y"]) {
      document.body.dispatchEvent(new KeyboardEvent("keydown", {
        key,
        bubbles: true,
        cancelable: true,
      }));
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    window.removeEventListener("message", capture);

    expect(copyMessages).toContainEqual({
      type: "plannotator-bridge-vim-copy",
      text: "Keyboard review fixture",
    });
    const reticle = document.querySelector<HTMLElement>(
      "[data-plannotator-vim-reticle]",
    );
    expect(reticle?.dataset.vimTargetPhase).toBe("block");
    expect(reticle?.dataset.vimTargetLabel).toBe("BLOCK · HEADING");

    postBridge({
      type: "plannotator-bridge-set-vim-mode",
      enabled: false,
    });
    document.body.replaceChildren();
  });

  test("restores the committed Visual range after annotation markup mutates the DOM", () => {
    postBridge({
      type: "plannotator-bridge-set-vim-mode",
      enabled: false,
    });
    document.body.innerHTML = "<p>Alpha bravo charlie</p>";
    postBridge({
      type: "plannotator-bridge-set-input-method",
      method: "drag",
    });
    postBridge({
      type: "plannotator-bridge-set-vim-mode",
      enabled: true,
      hudEnabled: false,
    });
    postBridge({ type: "plannotator-bridge-focus-vim" });

    for (const key of ["v", "w", "c"]) {
      document.body.dispatchEvent(new KeyboardEvent("keydown", {
        key,
        bubbles: true,
        cancelable: true,
      }));
    }
    expect(document.querySelector("[data-plannotator-vim-badge]")?.textContent)
      .toBe("ACTION · SELECT");

    postBridge({
      type: "plannotator-bridge-create-mark",
      id: "vim-committed-range",
      annotationType: "comment",
    });

    expect(document.querySelector("[data-plannotator-vim-badge]")?.textContent)
      .toBe("VISUAL · SELECT");
    expect(window.getSelection()?.toString()).toBe("Alpha ");
    expect(
      document.querySelector('[data-bind-id="vim-committed-range"]')?.textContent,
    ).toBe("Alpha ");

    postBridge({
      type: "plannotator-bridge-set-vim-mode",
      enabled: false,
    });
    document.body.replaceChildren();
  });

  test("restores a whole-block Visual range after annotation markup mutates the DOM", () => {
    postBridge({
      type: "plannotator-bridge-set-vim-mode",
      enabled: false,
    });
    document.body.innerHTML = "<p>Whole block target</p><p>After</p>";
    postBridge({
      type: "plannotator-bridge-set-input-method",
      method: "drag",
    });
    postBridge({
      type: "plannotator-bridge-set-vim-mode",
      enabled: true,
      hudEnabled: false,
    });
    postBridge({ type: "plannotator-bridge-focus-vim" });

    for (const key of ["V", "c"]) {
      document.body.dispatchEvent(new KeyboardEvent("keydown", {
        key,
        bubbles: true,
        cancelable: true,
      }));
    }
    expect(document.querySelector("[data-plannotator-vim-badge]")?.textContent)
      .toBe("ACTION · SELECT");

    postBridge({
      type: "plannotator-bridge-create-mark",
      id: "vim-committed-block-range",
      annotationType: "comment",
    });

    expect(document.querySelector("[data-plannotator-vim-badge]")?.textContent)
      .toBe("VISUAL BLOCK · SELECT");
    expect(window.getSelection()?.toString()).toBe("Whole block target");
    expect(
      document.querySelector('[data-bind-id="vim-committed-block-range"]')?.textContent,
    ).toBe("Whole block target");

    postBridge({
      type: "plannotator-bridge-set-vim-mode",
      enabled: false,
    });
    document.body.replaceChildren();
  });

  test("pinpoint click posts an anchored selection and never mutates the hovered element", async () => {
    document.body.innerHTML = [
      '<div id="hero"><p class="intro">Anchor target text</p><p>Second paragraph</p></div>',
    ].join("");
    postBridge({
      type: "plannotator-bridge-set-vim-mode",
      enabled: false,
    });
    postBridge({
      type: "plannotator-bridge-set-input-method",
      method: "pinpoint",
    });
    // Mode affordance: crosshair cursor attribute while pinpoint is active.
    expect(document.body.hasAttribute("data-plannotator-pinpoint-cursor")).toBe(true);

    const target = document.querySelector<HTMLElement>("p.intro");
    if (!target) throw new Error("target paragraph missing");

    // Hover: the overlay box appears; the page element gains no class/style.
    target.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, cancelable: true }));
    const box = document.querySelector<HTMLElement>("[data-plannotator-pinpoint-box]");
    if (!box) throw new Error("pinpoint hover box missing");
    expect(box.style.display).toBe("block");
    expect(target.className).toBe("intro");
    expect(target.getAttribute("style")).toBeNull();

    // Click-to-pin: posts a selection carrying a validated anchor + pinpoint flag.
    // Flush selection posts queued by earlier tests before collecting.
    await new Promise((resolve) => setTimeout(resolve, 0));
    const messages: Array<Record<string, unknown>> = [];
    const collect = (event: MessageEvent) => {
      const data = bridgeMessageData(event);
      if (data?.type === "plannotator-bridge-selection") messages.push(data);
    };
    window.addEventListener("message", collect);
    const click = new MouseEvent("click", { bubbles: true, cancelable: true });
    target.dispatchEvent(click);
    // postMessage delivery is task-queued — let it flush before collecting.
    await new Promise((resolve) => setTimeout(resolve, 0));
    window.removeEventListener("message", collect);

    expect(click.defaultPrevented).toBe(true); // page behavior suppressed
    expect(messages.length).toBe(1);
    const posted = messages[0]!;
    expect(posted.pinpoint).toBe(true);
    expect(posted.text).toBe("Anchor target text");
    const anchor = posted.anchor as { selector: string; tagName: string; text?: string };
    expect(anchor.tagName).toBe("p");
    expect(anchor.text).toBe("Anchor target text");
    // The serialized selector must uniquely resolve back to the pinned element.
    const matches = document.querySelectorAll(anchor.selector);
    expect(matches.length).toBe(1);
    expect(matches[0]).toBe(target);

    postBridge({ type: "plannotator-bridge-cancel-selection" });

    // Anchor-first restore: find-and-mark scoped to the resolved element.
    postBridge({
      type: "plannotator-bridge-find-and-mark",
      id: "pin-restore",
      originalText: "Anchor target text",
      annotationType: "comment",
      anchor,
    });
    const mark = document.querySelector('[data-bind-id="pin-restore"]');
    expect(mark?.textContent).toBe("Anchor target text");
    expect(target.contains(mark)).toBe(true);
    postBridge({ type: "plannotator-bridge-remove-mark", id: "pin-restore" });

    // Text drift under a STABLE anchor (#id): the element still identifies
    // itself, so when the text is gone everywhere it gets a numbered pin badge
    // (still counts as restored).
    postBridge({
      type: "plannotator-bridge-find-and-mark",
      id: "pin-badge",
      originalText: "Text that no longer exists anywhere",
      annotationType: "comment",
      anchor: { selector: "#hero", tagName: "div" },
    });
    const badge = document.querySelector<HTMLElement>("[data-plannotator-pin-badge]");
    if (!badge) throw new Error("pin badge missing");
    expect(badge.textContent).toBe("1");
    expect(document.querySelector('[data-bind-id="pin-badge"]')).toBeNull();

    // A weak anchor with NO text snapshot is rejected outright (a missing
    // snapshot is a rejection, not an exemption): restoration falls back to
    // the document-wide text search instead of trusting the element.
    postBridge({
      type: "plannotator-bridge-find-and-mark",
      id: "pin-no-snapshot",
      originalText: "Second paragraph",
      annotationType: "comment",
      anchor: { selector: anchor.selector, tagName: "p" },
    });
    const fallbackMark = document.querySelector('[data-bind-id="pin-no-snapshot"]');
    expect(fallbackMark?.textContent).toBe("Second paragraph");
    expect(target.contains(fallbackMark)).toBe(false);
    postBridge({ type: "plannotator-bridge-remove-mark", id: "pin-no-snapshot" });

    // Fail-closed anchors: a weak selector whose text snapshot no longer
    // matches must not resolve (falls back to document-wide text search).
    postBridge({
      type: "plannotator-bridge-find-and-mark",
      id: "pin-stale",
      originalText: "Second paragraph",
      annotationType: "comment",
      anchor: { selector: anchor.selector, tagName: "p", text: "Stale snapshot" },
    });
    const staleMark = document.querySelector('[data-bind-id="pin-stale"]');
    expect(staleMark?.textContent).toBe("Second paragraph");
    expect(target.contains(staleMark)).toBe(false);

    postBridge({ type: "plannotator-bridge-clear-marks" });
    expect(document.querySelector("[data-plannotator-pin-badge]")).toBeNull();
    postBridge({
      type: "plannotator-bridge-set-input-method",
      method: "drag",
    });
    expect(document.body.hasAttribute("data-plannotator-pinpoint-cursor")).toBe(false);
    document.body.replaceChildren();
  });

  test("deeply nested targets get no anchor instead of a quadratic selector walk", async () => {
    // Each ancestor step costs a document-wide uniqueness query against a
    // growing selector, so unbounded depth freezes the tab on one click
    // (measured ~58s at depth 800 pre-cap). Past MAX_ANCHOR_PATH_DEPTH the
    // anchor is abandoned and restoration falls back to text search.
    // Two structurally identical chains: every positional selector along the
    // walk matches both branches, so uniqueness cannot short-circuit before
    // the depth cap fires (the branch point sits above it).
    const DEPTH = 60;
    let chainA = "<p>Deeply buried text</p>";
    let chainB = "<p>Other branch text</p>";
    for (let i = 0; i < DEPTH; i++) {
      chainA = `<div>${chainA}</div>`;
      chainB = `<div>${chainB}</div>`;
    }
    document.body.innerHTML = chainA + chainB;
    const target = document.querySelector<HTMLElement>("p");
    if (!target || target.textContent !== "Deeply buried text") throw new Error("deep target missing");
    postBridge({ type: "plannotator-bridge-set-input-method", method: "pinpoint" });

    const messages: Array<Record<string, unknown>> = [];
    const collect = (event: MessageEvent) => {
      const data = bridgeMessageData(event);
      if (data?.type === "plannotator-bridge-selection") messages.push(data);
    };
    window.addEventListener("message", collect);
    const started = performance.now();
    target.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    const elapsed = performance.now() - started;
    await new Promise((resolve) => setTimeout(resolve, 0));
    window.removeEventListener("message", collect);

    expect(messages.length).toBe(1);
    expect(messages[0]!.text).toBe("Deeply buried text");
    expect((messages[0] as { anchor?: unknown }).anchor).toBeUndefined();
    // Bounded work: the capped walk must complete in interactive time even
    // under happy-dom's slow selector engine.
    expect(elapsed).toBeLessThan(2000);

    postBridge({ type: "plannotator-bridge-cancel-selection" });
    postBridge({ type: "plannotator-bridge-set-input-method", method: "drag" });
    document.body.replaceChildren();
  });

  test("behavioral-attribute anchors never bypass the text check", () => {
    // Regenerated page: the button kept its role but its meaning flipped; the
    // annotated text moved into a sibling paragraph. The role anchor must NOT
    // resolve (role names behavior, not content) — the annotation follows the
    // text via the document-wide search, and no pin lands on the button.
    document.body.innerHTML = [
      '<button role="button">Delete everything</button>',
      "<p>Save draft</p>",
    ].join("");
    postBridge({
      type: "plannotator-bridge-find-and-mark",
      id: "role-anchor",
      originalText: "Save draft",
      annotationType: "comment",
      anchor: { selector: 'button[role="button"]', tagName: "button", text: "Save draft" },
    });
    const mark = document.querySelector('[data-bind-id="role-anchor"]');
    expect(mark?.textContent).toBe("Save draft");
    expect(document.querySelector("button")?.contains(mark)).toBe(false);
    expect(document.querySelector("p")?.contains(mark)).toBe(true);
    expect(document.querySelector("[data-plannotator-pin-badge]")).toBeNull();
    postBridge({ type: "plannotator-bridge-clear-marks" });

    // data-* attributes ARE author-controlled identity: a data-testid anchor
    // whose text drifted still resolves, and with the text gone everywhere the
    // element gets the pin badge.
    document.body.innerHTML = '<div data-testid="stats">New numbers</div>';
    postBridge({
      type: "plannotator-bridge-find-and-mark",
      id: "data-anchor",
      originalText: "Old numbers",
      annotationType: "comment",
      anchor: { selector: 'div[data-testid="stats"]', tagName: "div", text: "Old numbers" },
    });
    expect(document.querySelector('[data-bind-id="data-anchor"]')).toBeNull();
    const dataBadge = document.querySelector<HTMLElement>("[data-plannotator-pin-badge]");
    expect(dataBadge).not.toBeNull();
    postBridge({ type: "plannotator-bridge-clear-marks" });
    document.body.replaceChildren();
  });

  test("data-test-id/data-cy/data-qa are author-controlled identity attrs", () => {
    // Same trust class as data-testid: the anchor resolves without a text
    // check even after the element's content drifted completely.
    document.body.innerHTML = '<div data-cy="metrics">Fresh content</div>';
    postBridge({
      type: "plannotator-bridge-find-and-mark",
      id: "cy-anchor",
      originalText: "Stale content gone from the page",
      annotationType: "comment",
      anchor: { selector: 'div[data-cy="metrics"]', tagName: "div", text: "Stale content gone from the page" },
    });
    expect(document.querySelector('[data-bind-id="cy-anchor"]')).toBeNull();
    expect(document.querySelector("[data-plannotator-pin-badge]")).not.toBeNull();
    postBridge({ type: "plannotator-bridge-clear-marks" });
    document.body.replaceChildren();
  });

  // --- New hit-testing contract: hover targets the real element under the
  // cursor (no tag whitelist, no has-text requirement). happy-dom has no
  // layout, so document.elementFromPoint yields nothing and resolution runs
  // from the event target — which in a real browser IS the deepest rendered
  // element under the pointer, the exact geometry these tests model.

  /** Signoff-page-shaped fixture: styled div/span chips, buttons, cards. */
  const SIGNOFF_MARKUP = [
    "<section><div class=\"frame\">",
    "<div class=\"ihead\"><span class=\"dnum\">R1</span>",
    "<span class=\"ibehav\">Empty library state</span></div>",
    "<div class=\"rline\"><span class=\"rkey\">no-jargon</span>",
    "<span class=\"rowchip\">adopted by 1</span></div>",
    "<span class=\"btn primary\">Create</span>",
    "</div></section>",
  ].join("");

  function hoverAt(el: Element, x: number, y: number) {
    el.dispatchEvent(new MouseEvent("mousemove", {
      bubbles: true,
      cancelable: true,
      clientX: x,
      clientY: y,
    }));
  }

  async function clickAndCollectSelection(el: Element, x: number, y: number) {
    await new Promise((resolve) => setTimeout(resolve, 0));
    const messages: Array<Record<string, unknown>> = [];
    const collect = (event: MessageEvent) => {
      const data = bridgeMessageData(event);
      if (data?.type === "plannotator-bridge-selection") messages.push(data);
    };
    window.addEventListener("message", collect);
    const click = new MouseEvent("click", {
      bubbles: true,
      cancelable: true,
      clientX: x,
      clientY: y,
    });
    el.dispatchEvent(click);
    await new Promise((resolve) => setTimeout(resolve, 0));
    window.removeEventListener("message", collect);
    return { click, messages };
  }

  test("chips and small buttons on div/span markup are individually targetable", async () => {
    document.body.innerHTML = SIGNOFF_MARKUP;
    postBridge({ type: "plannotator-bridge-set-vim-mode", enabled: false });
    postBridge({ type: "plannotator-bridge-set-input-method", method: "pinpoint" });

    const chip = document.querySelector<HTMLElement>("span.rowchip");
    if (!chip) throw new Error("chip fixture missing");

    // Hover resolves the chip itself — not the enclosing section.
    hoverAt(chip, 100, 100);
    const box = document.querySelector<HTMLElement>("[data-plannotator-pinpoint-box]");
    expect(box?.style.display).toBe("block");
    expect(
      document.querySelector<HTMLElement>("[data-plannotator-pinpoint-label]")?.textContent,
    ).toBe("rowchip");
    expect(chip.className).toBe("rowchip"); // page DOM untouched

    const { click, messages } = await clickAndCollectSelection(chip, 100, 100);
    expect(click.defaultPrevented).toBe(true);
    expect(messages.length).toBe(1);
    expect(messages[0]!.pinpoint).toBe(true);
    expect(messages[0]!.text).toBe("adopted by 1");
    const chipAnchor = messages[0]!.anchor as { selector: string; tagName: string; text?: string };
    expect(chipAnchor.tagName).toBe("span");
    const chipMatches = document.querySelectorAll(chipAnchor.selector);
    expect(chipMatches.length).toBe(1);
    expect(chipMatches[0]).toBe(chip);
    postBridge({ type: "plannotator-bridge-cancel-selection" });

    // The R1 chip and the small button resolve the same way.
    const dnum = document.querySelector<HTMLElement>("span.dnum");
    if (!dnum) throw new Error("dnum fixture missing");
    hoverAt(dnum, 200, 100);
    expect(
      document.querySelector<HTMLElement>("[data-plannotator-pinpoint-label]")?.textContent,
    ).toBe("dnum");
    const dnumResult = await clickAndCollectSelection(dnum, 200, 100);
    expect(dnumResult.messages.length).toBe(1);
    expect(dnumResult.messages[0]!.text).toBe("R1");
    postBridge({ type: "plannotator-bridge-cancel-selection" });

    const btn = document.querySelector<HTMLElement>("span.btn");
    if (!btn) throw new Error("button fixture missing");
    hoverAt(btn, 300, 100);
    expect(
      document.querySelector<HTMLElement>("[data-plannotator-pinpoint-label]")?.textContent,
    ).toBe("btn primary");
    const btnResult = await clickAndCollectSelection(btn, 300, 100);
    expect(btnResult.messages.length).toBe(1);
    expect(btnResult.messages[0]!.text).toBe("Create");

    postBridge({ type: "plannotator-bridge-cancel-selection" });
    postBridge({ type: "plannotator-bridge-set-input-method", method: "drag" });
    document.body.replaceChildren();
  });

  test("pointing at a container's uncovered area selects the container", async () => {
    // The geometric scope rule (matches the markdown surface): the deepest
    // element under the pointer wins, so a pointer over the card's padding —
    // where the card itself is the deepest rendered element — selects the
    // card, no keyboard or cycling involved.
    document.body.innerHTML = SIGNOFF_MARKUP;
    postBridge({ type: "plannotator-bridge-set-vim-mode", enabled: false });
    postBridge({ type: "plannotator-bridge-set-input-method", method: "pinpoint" });

    const frame = document.querySelector<HTMLElement>("div.frame");
    if (!frame) throw new Error("frame fixture missing");
    hoverAt(frame, 400, 150);
    expect(
      document.querySelector<HTMLElement>("[data-plannotator-pinpoint-label]")?.textContent,
    ).toBe("frame");
    const { messages } = await clickAndCollectSelection(frame, 400, 150);
    expect(messages.length).toBe(1);
    expect((messages[0]!.anchor as { tagName: string }).tagName).toBe("div");
    expect(String(messages[0]!.text)).toContain("no-jargon");

    postBridge({ type: "plannotator-bridge-cancel-selection" });
    postBridge({ type: "plannotator-bridge-set-input-method", method: "drag" });
    document.body.replaceChildren();
  });

  test("tiny elements promote to the nearest ancestor with a >=16px axis", () => {
    document.body.innerHTML = '<div class="card"><span class="dot"></span></div>';
    const card = document.querySelector<HTMLElement>("div.card");
    const dot = document.querySelector<HTMLElement>("span.dot");
    if (!card || !dot) throw new Error("promotion fixture missing");

    const mockRect = (x: number, y: number, width: number, height: number) => ({
      x, y, width, height,
      top: y, left: x, right: x + width, bottom: y + height,
      toJSON: () => ({}),
    }) as DOMRect;
    const originalBodyRect = document.body.getBoundingClientRect;
    document.body.getBoundingClientRect = () => mockRect(0, 0, 800, 600);
    dot.getBoundingClientRect = () => mockRect(10, 10, 8, 8);
    card.getBoundingClientRect = () => mockRect(5, 5, 200, 100);

    try {
      postBridge({ type: "plannotator-bridge-set-vim-mode", enabled: false });
      postBridge({ type: "plannotator-bridge-set-input-method", method: "pinpoint" });
      hoverAt(dot, 12, 12);
      const box = document.querySelector<HTMLElement>("[data-plannotator-pinpoint-box]");
      // The 8x8 dot is under 16px on both axes — the hover box outlines the
      // 200x100 card instead (a floor, not a whitelist).
      expect(box?.style.display).toBe("block");
      expect(box?.style.left).toBe("5px");
      expect(box?.style.width).toBe("200px");
      expect(
        document.querySelector<HTMLElement>("[data-plannotator-pinpoint-label]")?.textContent,
      ).toBe("card");
    } finally {
      document.body.getBoundingClientRect = originalBodyRect;
      postBridge({ type: "plannotator-bridge-set-input-method", method: "drag" });
      document.body.replaceChildren();
    }
  });

  test("generic-container labels follow the aria-label/role/class/text cascade", () => {
    document.body.innerHTML = [
      '<div class="stage">',
      '<div id="l-aria" aria-label="Close dialog" class="rowchip">x</div>',
      '<div id="l-role" role="tablist" class="abc12345">x</div>',
      '<div id="l-class" class="styles_Card_a1b2c3">x</div>',
      '<span id="l-text">R9</span>',
      '<div id="l-container"><span>This text is far too long to serve as a hover label for anything</span></div>',
      '<div id="l-long" class="extraverboseclasstokennameone extraverboseclasstokennametwo">x</div>',
      "<p id=\"l-known\">Paragraph text</p>",
      "</div>",
    ].join("");
    postBridge({ type: "plannotator-bridge-set-vim-mode", enabled: false });
    postBridge({ type: "plannotator-bridge-set-input-method", method: "pinpoint" });

    const label = () =>
      document.querySelector<HTMLElement>("[data-plannotator-pinpoint-label]")?.textContent;
    const cases: Array<[string, string]> = [
      ["#l-aria", "Close dialog"], // aria-label beats classes
      ["#l-role", "tablist"], // role beats a hash-looking class
      ["#l-class", "styles Card"], // meaningful tokens, hash token stripped
      ["#l-text", "R9"], // short own text for class-less spans
      ["#l-container", "container"], // nothing meaningful -> container
      // Class-token labels obey the 40-char cap like every other rung.
      ["#l-long", "extraverboseclasstokennameone extraverbo"],
      ["#l-known", "Paragraph"], // known tags keep their names
    ];
    let x = 10;
    for (const [selector, expected] of cases) {
      const el = document.querySelector<HTMLElement>(selector);
      if (!el) throw new Error(`label fixture ${selector} missing`);
      hoverAt(el, (x += 50), 40);
      expect(label()).toBe(expected);
    }

    postBridge({ type: "plannotator-bridge-set-input-method", method: "drag" });
    document.body.replaceChildren();
  });

  test("text-less elements anchor only through a stable-identity rung", async () => {
    // A text-less element has no snapshot to verify a weak anchor against, so
    // it gets an anchor ONLY when the element itself carries stable identity
    // (#id or an author-controlled data-* identity attribute). It is still
    // annotatable either way — the selection describes the element.
    document.body.innerHTML = [
      '<div class="toolbar">',
      '<span class="icon-close" data-testid="close-btn"></span>',
      '<span class="icon-menu"></span>',
      "<p>Sibling text</p></div>",
    ].join("");
    postBridge({ type: "plannotator-bridge-set-vim-mode", enabled: false });
    postBridge({ type: "plannotator-bridge-set-input-method", method: "pinpoint" });

    const close = document.querySelector<HTMLElement>("span.icon-close");
    if (!close) throw new Error("icon fixture missing");
    hoverAt(close, 60, 60);
    const { click, messages } = await clickAndCollectSelection(close, 60, 60);
    expect(click.defaultPrevented).toBe(true);
    expect(messages.length).toBe(1);
    // No text to quote: the posted selection describes the element.
    expect(messages[0]!.text).toBe("[element: icon close]");
    const anchor = messages[0]!.anchor as { selector: string; tagName: string; text?: string };
    expect(anchor.selector).toBe('span[data-testid="close-btn"]');
    expect(anchor.text).toBe("");
    postBridge({ type: "plannotator-bridge-cancel-selection" });

    // Round trip: the stable-identity anchor resolves without a text check,
    // so the icon gets a pin badge even though text search can never succeed.
    postBridge({
      type: "plannotator-bridge-find-and-mark",
      id: "identity-pin",
      originalText: "[element: icon close]",
      annotationType: "comment",
      anchor,
    });
    expect(document.querySelector("[data-plannotator-pin-badge]")).not.toBeNull();
    expect(document.querySelector('[data-bind-id="identity-pin"]')).toBeNull();
    postBridge({ type: "plannotator-bridge-clear-marks" });
    expect(document.querySelector("[data-plannotator-pin-badge]")).toBeNull();

    // A text-less element with only classes (weak selector) ships NO anchor:
    // there is nothing to verify against, and a wrong-binding anchor is
    // worse than no anchor.
    const menu = document.querySelector<HTMLElement>("span.icon-menu");
    if (!menu) throw new Error("menu icon fixture missing");
    hoverAt(menu, 90, 60);
    const menuResult = await clickAndCollectSelection(menu, 90, 60);
    expect(menuResult.messages.length).toBe(1);
    expect(menuResult.messages[0]!.text).toBe("[element: icon menu]");
    expect(menuResult.messages[0]!.anchor).toBeUndefined();

    postBridge({ type: "plannotator-bridge-cancel-selection" });
    postBridge({ type: "plannotator-bridge-set-input-method", method: "drag" });
    document.body.replaceChildren();
  });

  test("identical text-less siblings fail closed instead of rebinding (D1)", async () => {
    // Two structurally identical icons: any structure-derived signature
    // (tag/classes/child count/size) is identical across them, so a
    // positional selector whose sibling was removed would resolve to the
    // WRONG element and still "verify". The contract is therefore: no anchor
    // at all for weak text-less targets, and a crafted positional anchor
    // with no snapshot never resolves.
    document.body.innerHTML = [
      '<div class="strip">',
      '<span class="icon"></span>',
      '<span class="icon"></span>',
      "</div>",
    ].join("");
    postBridge({ type: "plannotator-bridge-set-vim-mode", enabled: false });
    postBridge({ type: "plannotator-bridge-set-input-method", method: "pinpoint" });

    const second = document.querySelectorAll<HTMLElement>("span.icon")[1];
    if (!second) throw new Error("sibling fixture missing");
    hoverAt(second, 120, 60);
    const { messages } = await clickAndCollectSelection(second, 120, 60);
    expect(messages.length).toBe(1);
    expect(messages[0]!.anchor).toBeUndefined();
    postBridge({ type: "plannotator-bridge-cancel-selection" });

    // The old-world failure mode, replayed: after the first icon is removed,
    // span.icon:nth-of-type(2) is gone and span.icon:nth-of-type(1) IS a
    // different element. A crafted positional anchor (empty snapshot) must
    // resolve nothing — no pin, no mark, anywhere.
    second.parentElement!.removeChild(document.querySelectorAll("span.icon")[0]!);
    for (const selector of ["div.strip > span:nth-of-type(2)", "div.strip > span:nth-of-type(1)"]) {
      postBridge({
        type: "plannotator-bridge-find-and-mark",
        id: `rebind-${selector}`,
        originalText: "[element: icon]",
        annotationType: "comment",
        anchor: { selector, tagName: "span", text: "" },
      });
    }
    expect(document.querySelector("[data-plannotator-pin-badge]")).toBeNull();
    expect(document.querySelector("[data-bind-id]")).toBeNull();

    postBridge({ type: "plannotator-bridge-set-input-method", method: "drag" });
    document.body.replaceChildren();
  });

  test("badge click ownership is identity-gated, not selector-gated (D5)", async () => {
    // A page element spoofing our badge attribute is NOT a viewer overlay:
    // it hovers and annotates like any other element.
    document.body.innerHTML = "<div data-plannotator-pin-badge class=\"fake-badge\">7</div><p id=\"pin-me\">Pinned text</p>";
    postBridge({ type: "plannotator-bridge-set-vim-mode", enabled: false });
    postBridge({ type: "plannotator-bridge-set-input-method", method: "pinpoint" });

    const spoof = document.querySelector<HTMLElement>("div.fake-badge");
    if (!spoof) throw new Error("spoof fixture missing");
    hoverAt(spoof, 40, 40);
    expect(
      document.querySelector<HTMLElement>("[data-plannotator-pinpoint-box]")?.style.display,
    ).toBe("block");
    const { click, messages } = await clickAndCollectSelection(spoof, 40, 40);
    expect(click.defaultPrevented).toBe(true);
    expect(messages.length).toBe(1);
    expect(messages[0]!.text).toBe("7");

    // A REAL badge still owns its click: it posts mark-click, not a selection.
    postBridge({
      type: "plannotator-bridge-find-and-mark",
      id: "badge-owner",
      originalText: "Text that exists nowhere on this page",
      annotationType: "comment",
      anchor: { selector: "#pin-me", tagName: "p" },
    });
    const realBadge = document.querySelector<HTMLElement>(
      "[data-plannotator-pin-badge]:not(.fake-badge)",
    );
    if (!realBadge) throw new Error("real badge missing");
    const collected: Array<Record<string, unknown>> = [];
    const collect = (event: MessageEvent) => {
      const data = bridgeMessageData(event);
      if (
        data?.type === "plannotator-bridge-selection"
        || data?.type === "plannotator-bridge-mark-click"
      ) collected.push(data);
    };
    window.addEventListener("message", collect);
    realBadge.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    window.removeEventListener("message", collect);
    expect(collected).toEqual([
      { type: "plannotator-bridge-mark-click", id: "badge-owner" },
    ]);

    postBridge({ type: "plannotator-bridge-clear-marks" });
    postBridge({ type: "plannotator-bridge-set-input-method", method: "drag" });
    document.body.replaceChildren();
  });

  // --- Shift-click multi-select: several elements, ONE draft comment ---

  const MULTI_MARKUP = [
    '<div id="hero">',
    '<p class="alpha">Alpha text</p>',
    '<p class="beta">Beta text</p>',
    '<p class="gamma">Gamma text</p>',
    "</div>",
  ].join("");

  type BridgeData = Record<string, unknown>;

  /** Collect bridge messages of the given types across one synchronous action. */
  async function collectMessages(
    types: string[],
    action: () => void,
  ): Promise<BridgeData[]> {
    await new Promise((resolve) => setTimeout(resolve, 0)); // flush queued posts
    const messages: BridgeData[] = [];
    const collect = (event: MessageEvent) => {
      const data = bridgeMessageData(event);
      if (data && types.includes(String(data.type))) messages.push(data);
    };
    window.addEventListener("message", collect);
    action();
    await new Promise((resolve) => setTimeout(resolve, 0));
    window.removeEventListener("message", collect);
    return messages;
  }

  function clickAt(el: Element, x: number, y: number, shift: boolean) {
    el.dispatchEvent(new MouseEvent("click", {
      bubbles: true,
      cancelable: true,
      clientX: x,
      clientY: y,
      shiftKey: shift,
    }));
  }

  function pinnedBoxCount(): number {
    return document.querySelectorAll("[data-plannotator-pinpoint-box][data-pinned]").length;
  }

  async function startMultiDraft(options?: { arm?: boolean }): Promise<{
    primaryKey: string;
    keys: Map<string, string>; // className -> target key
  }> {
    postBridge({ type: "plannotator-bridge-set-vim-mode", enabled: false });
    postBridge({ type: "plannotator-bridge-set-input-method", method: "pinpoint" });
    const alpha = document.querySelector<HTMLElement>("p.alpha")!;
    const selections = await collectMessages(
      ["plannotator-bridge-selection"],
      () => clickAt(alpha, 20, 20, false),
    );
    expect(selections.length).toBe(1);
    expect(selections[0]!.pinpoint).toBe(true);
    expect(typeof selections[0]!.targetKey).toBe("string");
    expect(selections[0]!.targetLabel).toBe("Paragraph");
    const primaryKey = String(selections[0]!.targetKey);
    // The parent arms multi-select only when its comment composer mirrors the
    // draft — replayed here unless the test wants an UNARMED draft.
    if (options?.arm !== false) {
      postBridge({ type: "plannotator-bridge-arm-multi-select", key: primaryKey });
    }
    const keys = new Map<string, string>();
    keys.set("alpha", primaryKey);
    return { primaryKey, keys };
  }

  test("shift-click adds targets to the SAME draft and toggles them off again", async () => {
    document.body.innerHTML = MULTI_MARKUP;
    const { keys } = await startMultiDraft();
    const beta = document.querySelector<HTMLElement>("p.beta")!;
    const gamma = document.querySelector<HTMLElement>("p.gamma")!;

    // Shift-click beta: joins the draft, posts a validated target DTO, and
    // gets its own pinned outline box (primary keeps the main box).
    const added = await collectMessages(
      ["plannotator-bridge-multi-target-added"],
      () => clickAt(beta, 40, 40, true),
    );
    expect(added.length).toBe(1);
    expect(added[0]!.label).toBe("Paragraph");
    expect(added[0]!.text).toBe("Beta text");
    const betaAnchor = added[0]!.anchor as { selector: string };
    const betaMatches = document.querySelectorAll(betaAnchor.selector);
    expect(betaMatches.length).toBe(1);
    expect(betaMatches[0]).toBe(beta);
    keys.set("beta", String(added[0]!.key));
    expect(pinnedBoxCount()).toBe(2);

    const addedGamma = await collectMessages(
      ["plannotator-bridge-multi-target-added"],
      () => clickAt(gamma, 60, 60, true),
    );
    expect(addedGamma.length).toBe(1);
    expect(pinnedBoxCount()).toBe(3);

    // Shift-click beta AGAIN: toggle-off by DOM identity — the removal is
    // echoed to the parent and beta's outline box disappears.
    const removed = await collectMessages(
      ["plannotator-bridge-multi-target-added", "plannotator-bridge-multi-target-removed"],
      () => clickAt(beta, 40, 40, true),
    );
    expect(removed.length).toBe(1);
    expect(removed[0]!.type).toBe("plannotator-bridge-multi-target-removed");
    expect(removed[0]!.key).toBe(keys.get("beta"));
    expect(pinnedBoxCount()).toBe(2);

    postBridge({ type: "plannotator-bridge-cancel-selection" });
    expect(pinnedBoxCount()).toBe(0);
    postBridge({ type: "plannotator-bridge-set-input-method", method: "drag" });
    document.body.replaceChildren();
  });

  test("create-mark commits every draft target under ONE id with ONE badge number", async () => {
    document.body.innerHTML = MULTI_MARKUP;
    await startMultiDraft();
    clickAt(document.querySelector("p.beta")!, 40, 40, true);
    clickAt(document.querySelector("p.gamma")!, 60, 60, true);
    await new Promise((resolve) => setTimeout(resolve, 0));

    postBridge({
      type: "plannotator-bridge-create-mark",
      id: "multi-commit",
      annotationType: "comment",
    });

    // Primary keeps its text mark (or pin); beta + gamma each get a pin —
    // and every badge for this annotation shows the SAME number.
    const badges = Array.from(
      document.querySelectorAll<HTMLElement>("[data-plannotator-pin-badge]"),
    );
    expect(badges.length).toBeGreaterThanOrEqual(2);
    for (const badge of badges) expect(badge.textContent).toBe("1");
    expect(pinnedBoxCount()).toBe(0); // draft state fully cleared

    // A SECOND annotation numbers 2 — multi-target pins consumed only one slot.
    postBridge({
      type: "plannotator-bridge-find-and-mark",
      id: "second-ann",
      originalText: "Text that exists nowhere on this page",
      annotationType: "comment",
      anchor: { selector: "#hero", tagName: "div" },
    });
    const allBadges = Array.from(
      document.querySelectorAll<HTMLElement>("[data-plannotator-pin-badge]"),
    );
    const numbers = allBadges.map((b) => b.textContent);
    expect(numbers).toContain("2");
    expect(numbers.filter((n) => n === "1").length).toBeGreaterThanOrEqual(2);
    expect(numbers.filter((n) => n === "2").length).toBe(1);

    postBridge({ type: "plannotator-bridge-clear-marks" });
    postBridge({ type: "plannotator-bridge-set-input-method", method: "drag" });
    document.body.replaceChildren();
  });

  test("removing the primary promotes the next target; removing the last cancels", async () => {
    document.body.innerHTML = MULTI_MARKUP;
    const { primaryKey } = await startMultiDraft();
    const beta = document.querySelector<HTMLElement>("p.beta")!;
    clickAt(beta, 40, 40, true);
    await new Promise((resolve) => setTimeout(resolve, 0));

    // Shift-click the PRIMARY: it is removed and beta is promoted.
    const removals = await collectMessages(
      ["plannotator-bridge-multi-target-removed"],
      () => clickAt(document.querySelector("p.alpha")!, 20, 20, true),
    );
    expect(removals.length).toBe(1);
    expect(removals[0]!.key).toBe(primaryKey);
    expect(pinnedBoxCount()).toBe(1); // only the promoted primary's main box

    // Committing now pins the PROMOTED element (beta), not alpha.
    postBridge({
      type: "plannotator-bridge-create-mark",
      id: "promoted-commit",
      annotationType: "comment",
    });
    const badge = document.querySelector<HTMLElement>("[data-plannotator-pin-badge]");
    expect(badge).not.toBeNull();
    expect(document.querySelector('[data-bind-id="promoted-commit"]')).toBeNull();
    postBridge({ type: "plannotator-bridge-clear-marks" });

    // Fresh draft with ONLY a primary: shift-clicking it cancels the draft —
    // a later create-mark must commit nothing.
    const again = await startMultiDraft();
    const cancel = await collectMessages(
      ["plannotator-bridge-multi-target-removed"],
      () => clickAt(document.querySelector("p.alpha")!, 20, 20, true),
    );
    expect(cancel.length).toBe(1);
    expect(cancel[0]!.key).toBe(again.primaryKey);
    expect(pinnedBoxCount()).toBe(0);
    postBridge({
      type: "plannotator-bridge-create-mark",
      id: "cancelled-commit",
      annotationType: "comment",
    });
    expect(document.querySelector('[data-bind-id="cancelled-commit"]')).toBeNull();
    expect(document.querySelector("[data-plannotator-pin-badge]")).toBeNull();

    postBridge({ type: "plannotator-bridge-set-input-method", method: "drag" });
    document.body.replaceChildren();
  });

  test("UNARMED pinpoint drafts refuse the shift-toggle (D1: quickLabel-style modes)", async () => {
    // The parent only mirrors targets while the comment composer owns the
    // draft; quickLabel/redline drafts never send arm-multi-select. A
    // shift-click on such a draft must NOT accumulate bridge-side targets the
    // saved annotation would not carry — it behaves as a plain click.
    document.body.innerHTML = MULTI_MARKUP;
    await startMultiDraft({ arm: false });
    const beta = document.querySelector<HTMLElement>("p.beta")!;

    const messages = await collectMessages(
      ["plannotator-bridge-multi-target-added", "plannotator-bridge-selection"],
      () => clickAt(beta, 40, 40, true),
    );
    // No multi-target-added; the shift-click replaced the draft instead.
    expect(messages.length).toBe(1);
    expect(messages[0]!.type).toBe("plannotator-bridge-selection");
    expect(messages[0]!.text).toBe("Beta text");
    expect(pinnedBoxCount()).toBe(1); // only the (new) primary's main box

    // Committing registers nothing beyond the new primary — no orphan pins.
    postBridge({
      type: "plannotator-bridge-create-mark",
      id: "unarmed-commit",
      annotationType: "comment",
    });
    expect(
      document.querySelectorAll("[data-plannotator-pin-badge]").length,
    ).toBeLessThanOrEqual(1);

    postBridge({ type: "plannotator-bridge-clear-marks" });
    postBridge({ type: "plannotator-bridge-cancel-selection" });
    postBridge({ type: "plannotator-bridge-set-input-method", method: "drag" });
    document.body.replaceChildren();
  });

  test("a stale or mismatched arm key never arms a draft", async () => {
    document.body.innerHTML = MULTI_MARKUP;
    await startMultiDraft({ arm: false });
    postBridge({ type: "plannotator-bridge-arm-multi-select", key: "not-the-primary" });
    const messages = await collectMessages(
      ["plannotator-bridge-multi-target-added"],
      () => clickAt(document.querySelector("p.beta")!, 40, 40, true),
    );
    expect(messages.length).toBe(0);
    postBridge({ type: "plannotator-bridge-cancel-selection" });
    postBridge({ type: "plannotator-bridge-set-input-method", method: "drag" });
    document.body.replaceChildren();
  });

  test("arming is per-draft: a NEW draft after an armed one starts unarmed (D1-R)", async () => {
    // The stale-arm regression: comment-mode draft gets armed, the user
    // switches to a mode the parent does not mirror (quick label posts
    // nothing to the bridge), then starts a NEW draft with a plain click.
    // Without a per-draft reset the old arm leaks into the new draft and the
    // bridge accumulates outlines/pins the saved annotation will not carry.
    document.body.innerHTML = MULTI_MARKUP;
    const { primaryKey } = await startMultiDraft(); // armed comment draft
    postBridge({ type: "plannotator-bridge-arm-multi-select", key: primaryKey });

    // New draft via plain click (no cancel-selection, no re-arm) — exactly
    // what a toolbar mode change followed by a pinpoint click produces.
    const beta = document.querySelector<HTMLElement>("p.beta")!;
    await collectMessages(["plannotator-bridge-selection"], () => clickAt(beta, 40, 40, false));

    // Shift-click on the unarmed new draft must NOT add a target.
    const added = await collectMessages(
      ["plannotator-bridge-multi-target-added"],
      () => clickAt(document.querySelector("p.gamma") ?? document.querySelector("p.alpha")!, 40, 40, true),
    );
    expect(added.length).toBe(0);

    // Committing the new draft registers at most its own primary: no orphans.
    postBridge({
      type: "plannotator-bridge-create-mark",
      id: "stale-arm-commit",
      annotationType: "comment",
    });
    expect(
      document.querySelectorAll("[data-plannotator-pin-badge]").length,
    ).toBeLessThanOrEqual(1);

    postBridge({ type: "plannotator-bridge-clear-marks" });
    postBridge({ type: "plannotator-bridge-cancel-selection" });
    postBridge({ type: "plannotator-bridge-set-input-method", method: "drag" });
    document.body.replaceChildren();
  });

  test("remove-target is idempotent and resyncs a forged primary removal (D4)", async () => {
    document.body.innerHTML = MULTI_MARKUP;
    const { primaryKey } = await startMultiDraft();
    const added = await collectMessages(
      ["plannotator-bridge-multi-target-added"],
      () => clickAt(document.querySelector("p.beta")!, 40, 40, true),
    );
    const betaKey = String(added[0]!.key);
    expect(pinnedBoxCount()).toBe(2);

    // Forged-removal scenario: the parent believed the primary was removed
    // (hostile multi-target-removed) and echoes remove-target back. The
    // bridge, which never removed it, now performs the SAME promotion —
    // both sides converge on beta as the primary.
    postBridge({ type: "plannotator-bridge-remove-target", key: primaryKey });
    expect(pinnedBoxCount()).toBe(1);

    // Idempotency: the same removal again (double echo) is a no-op.
    postBridge({ type: "plannotator-bridge-remove-target", key: primaryKey });
    expect(pinnedBoxCount()).toBe(1);

    // Committing pins the promoted element (beta), matching the parent model.
    postBridge({
      type: "plannotator-bridge-create-mark",
      id: "resync-commit",
      annotationType: "comment",
    });
    const badge = document.querySelector<HTMLElement>("[data-plannotator-pin-badge]");
    expect(badge).not.toBeNull();
    postBridge({ type: "plannotator-bridge-clear-marks" });
    postBridge({ type: "plannotator-bridge-set-input-method", method: "drag" });
    void betaKey;
    document.body.replaceChildren();
  });

  test("parent-initiated remove-target mirrors without echoing back", async () => {
    document.body.innerHTML = MULTI_MARKUP;
    await startMultiDraft();
    const added = await collectMessages(
      ["plannotator-bridge-multi-target-added"],
      () => clickAt(document.querySelector("p.beta")!, 40, 40, true),
    );
    const betaKey = String(added[0]!.key);
    expect(pinnedBoxCount()).toBe(2);

    const echoes = await collectMessages(
      ["plannotator-bridge-multi-target-removed"],
      () => postBridge({ type: "plannotator-bridge-remove-target", key: betaKey }),
    );
    expect(echoes.length).toBe(0); // the parent already updated its own list
    expect(pinnedBoxCount()).toBe(1);

    // flash-target on the survivor must not throw or change draft state.
    postBridge({ type: "plannotator-bridge-flash-target", key: betaKey });
    expect(pinnedBoxCount()).toBe(1);

    postBridge({ type: "plannotator-bridge-cancel-selection" });
    postBridge({ type: "plannotator-bridge-set-input-method", method: "drag" });
    document.body.replaceChildren();
  });

  test("the multi-target draft is capped at 16 additional targets in the bridge", async () => {
    const paragraphs: string[] = [];
    for (let i = 0; i < 20; i++) paragraphs.push(`<p class="cap-${i}">Cap target ${i}</p>`);
    document.body.innerHTML = `<div id="cap-stage">${paragraphs.join("")}</div>`;
    postBridge({ type: "plannotator-bridge-set-vim-mode", enabled: false });
    postBridge({ type: "plannotator-bridge-set-input-method", method: "pinpoint" });
    const primarySelections = await collectMessages(
      ["plannotator-bridge-selection"],
      () => clickAt(document.querySelector("p.cap-0")!, 10, 10, false), // primary
    );
    postBridge({
      type: "plannotator-bridge-arm-multi-select",
      key: String(primarySelections[0]!.targetKey),
    });

    const added = await collectMessages(
      ["plannotator-bridge-multi-target-added"],
      () => {
        for (let i = 1; i < 20; i++) {
          clickAt(document.querySelector(`p.cap-${i}`)!, 10 + i, 10, true);
        }
      },
    );
    expect(added.length).toBe(16);

    postBridge({ type: "plannotator-bridge-cancel-selection" });
    postBridge({ type: "plannotator-bridge-set-input-method", method: "drag" });
    document.body.replaceChildren();
  });

  test("find-and-mark restores additional anchors as same-numbered pins, fail-closed", async () => {
    document.body.innerHTML = MULTI_MARKUP;
    postBridge({
      type: "plannotator-bridge-find-and-mark",
      id: "restore-multi",
      originalText: "Alpha text",
      annotationType: "comment",
      anchor: { selector: "p.alpha", tagName: "p", text: "Alpha text" },
      additionalAnchors: [
        { selector: "p.beta", tagName: "p", text: "Beta text" },
        // Stale snapshot: this anchor must NOT resolve (no pin, no mis-mark).
        { selector: "p.gamma", tagName: "p", text: "Stale snapshot" },
      ],
    });

    // Primary restored as an inline mark inside alpha.
    const mark = document.querySelector('[data-bind-id="restore-multi"]');
    expect(mark?.textContent).toBe("Alpha text");
    // Beta restored as a pin sharing the annotation's number; gamma failed closed.
    const badges = Array.from(
      document.querySelectorAll<HTMLElement>("[data-plannotator-pin-badge]"),
    );
    expect(badges.length).toBe(1);
    expect(badges[0]!.textContent).toBe("1");

    postBridge({ type: "plannotator-bridge-remove-mark", id: "restore-multi" });
    expect(document.querySelector('[data-bind-id="restore-multi"]')).toBeNull();
    expect(document.querySelector("[data-plannotator-pin-badge]")).toBeNull();
    document.body.replaceChildren();
  });

  test("hover hit-testing never storms document-wide queries per mousemove", () => {
    // The old hover path rebuilt the semantic target graph (three
    // document-wide querySelectorAll sweeps) on every pointer frame. The new
    // path is per-event hit-testing: element identity plus closest() walks,
    // zero document-wide queries. Graph builds remain click/vim-time only.
    document.body.innerHTML = SIGNOFF_MARKUP;
    postBridge({ type: "plannotator-bridge-set-vim-mode", enabled: false });
    postBridge({ type: "plannotator-bridge-set-input-method", method: "pinpoint" });

    const targets = Array.from(document.querySelectorAll<HTMLElement>("span, div, section"));
    const originalQsa = document.querySelectorAll.bind(document);
    let documentWideQueries = 0;
    (document as { querySelectorAll: typeof document.querySelectorAll }).querySelectorAll = ((
      ...args: Parameters<typeof document.querySelectorAll>
    ) => {
      documentWideQueries += 1;
      return originalQsa(...args);
    }) as typeof document.querySelectorAll;

    try {
      let x = 0;
      for (let i = 0; i < 30; i++) {
        const el = targets[i % targets.length]!;
        hoverAt(el, (x += 23), 90);
      }
      expect(documentWideQueries).toBe(0);
    } finally {
      (document as { querySelectorAll: typeof document.querySelectorAll }).querySelectorAll = originalQsa;
      postBridge({ type: "plannotator-bridge-set-input-method", method: "drag" });
      document.body.replaceChildren();
    }
  });
});

describe("injectIntoHead", () => {
  test("splices before </head> when present, else prepends", () => {
    expect(injectIntoHead("<html><head><title>t</title></head><body/></html>", "[X]")).toBe(
      "<html><head><title>t</title>[X]</head><body/></html>",
    );
    expect(injectIntoHead("<p>no head</p>", "[X]")).toBe("[X]<p>no head</p>");
  });
});
