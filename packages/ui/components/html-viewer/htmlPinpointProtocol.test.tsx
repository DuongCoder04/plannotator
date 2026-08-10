/**
 * Bridge-protocol contract for HTML pinpoint mode (DOM-gated).
 *
 * The bridge script runs inside a sandboxed iframe rendering arbitrary HTML,
 * so everything it posts must be validated and size-capped before it reaches
 * React state or the annotation model. These tests cover the pinpoint
 * additions: the element-anchor DTO, the pinpoint click-to-pin flow (straight
 * to the comment composer, skipping the toolbar), and anchor propagation onto
 * created annotations.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import type { Annotation } from '../../types';

const hasDom = typeof document !== 'undefined';
const hookModule = hasDom ? await import('./useHtmlAnnotation') : null;
const htmlViewerModule = hasDom ? await import('./HtmlViewer') : null;

// Unmount every root before clearing the DOM: leaving HtmlViewer instances
// mounted would keep their window message listeners alive and leak into other
// test files sharing this process.
const mountedRoots: Array<{ unmount: () => void }> = [];

afterEach(async () => {
  if (!hasDom) return;
  await act(async () => {
    for (const root of mountedRoots.splice(0)) root.unmount();
  });
  document.body.replaceChildren();
});

describe.if(hasDom)('parseHtmlElementAnchor (validated DTO)', () => {
  test('accepts a well-formed anchor', () => {
    expect(hookModule!.parseHtmlElementAnchor({
      selector: '#hero > p:nth-of-type(2)',
      tagName: 'p',
      text: 'Some text',
    })).toEqual({ selector: '#hero > p:nth-of-type(2)', tagName: 'p', text: 'Some text' });
  });

  test('accepts an anchor without a text snapshot', () => {
    expect(hookModule!.parseHtmlElementAnchor({ selector: 'main', tagName: 'main' }))
      .toEqual({ selector: 'main', tagName: 'main' });
  });

  test('rejects non-records and missing/empty fields', () => {
    expect(hookModule!.parseHtmlElementAnchor(null)).toBeNull();
    expect(hookModule!.parseHtmlElementAnchor('main')).toBeNull();
    expect(hookModule!.parseHtmlElementAnchor({})).toBeNull();
    expect(hookModule!.parseHtmlElementAnchor({ selector: '', tagName: 'p' })).toBeNull();
    expect(hookModule!.parseHtmlElementAnchor({ selector: 'p' })).toBeNull();
    expect(hookModule!.parseHtmlElementAnchor({ selector: 'p', tagName: 42 })).toBeNull();
  });

  test('rejects oversized fields (size caps)', () => {
    expect(hookModule!.parseHtmlElementAnchor({
      selector: 'x'.repeat(1025),
      tagName: 'p',
    })).toBeNull();
    expect(hookModule!.parseHtmlElementAnchor({
      selector: 'p',
      tagName: 'x'.repeat(65),
    })).toBeNull();
    expect(hookModule!.parseHtmlElementAnchor({
      selector: 'p',
      tagName: 'p',
      text: 'x'.repeat(401),
    })).toBeNull();
  });
});

describe.if(hasDom)('parseBridgeMessage selection additions', () => {
  const rect = { top: 10, left: 10, width: 100, height: 20 };

  test('carries a validated anchor and the pinpoint flag', () => {
    const parsed = hookModule!.parseBridgeMessage({
      type: 'plannotator-bridge-selection',
      text: 'Hello',
      rect,
      anchor: { selector: 'p.intro', tagName: 'p', text: 'Hello' },
      pinpoint: true,
    });
    expect(parsed).toMatchObject({
      text: 'Hello',
      pinpoint: true,
      anchor: { selector: 'p.intro', tagName: 'p', text: 'Hello' },
    });
  });

  test('a malformed anchor is dropped without rejecting the selection', () => {
    const parsed = hookModule!.parseBridgeMessage({
      type: 'plannotator-bridge-selection',
      text: 'Hello',
      rect,
      anchor: { selector: 42 },
      pinpoint: 'yes',
    });
    expect(parsed).toMatchObject({ text: 'Hello', pinpoint: false });
    expect((parsed as { anchor?: unknown }).anchor).toBeUndefined();
  });

  test('truncation never splits a surrogate pair at the cap boundary', () => {
    // An astral character straddling the cut would leave a lone high
    // surrogate that turns into U+FFFD once UTF-8-encoded (drafts, feedback,
    // share URLs) — the cut must back off one unit instead.
    const cap = hookModule!.MAX_SELECTION_TEXT_LENGTH;
    const straddling = 'x'.repeat(cap - 1) + '\u{1F600}' + 'tail';
    const parsed = hookModule!.parseBridgeMessage({
      type: 'plannotator-bridge-selection',
      text: straddling,
      rect,
    }) as { text: string };
    expect(parsed.text.length).toBe(cap - 1);
    expect(parsed.text.endsWith('x')).toBe(true);
    expect(/[\uD800-\uDBFF]$/.test(parsed.text)).toBe(false);
    // A pair that fits entirely under the cap is untouched.
    const fitting = 'y'.repeat(cap - 2) + '\u{1F600}';
    const kept = hookModule!.parseBridgeMessage({
      type: 'plannotator-bridge-selection',
      text: fitting,
      rect,
    }) as { text: string };
    expect(kept.text).toBe(fitting);
  });

  test('selection text is truncated at the parse boundary, not rejected', () => {
    // The page controls element text entirely, so one pinpoint click on a huge
    // <pre> could otherwise ship an unbounded string into React state, drafts,
    // exported feedback, and share URLs.
    const cap = hookModule!.MAX_SELECTION_TEXT_LENGTH;
    const parsed = hookModule!.parseBridgeMessage({
      type: 'plannotator-bridge-selection',
      text: 'x'.repeat(cap + 590_000),
      rect,
    });
    expect(parsed).not.toBeNull();
    expect((parsed as { text: string }).text.length).toBe(cap);
    // At or under the cap passes through untouched.
    const exact = hookModule!.parseBridgeMessage({
      type: 'plannotator-bridge-selection',
      text: 'y'.repeat(cap),
      rect,
    });
    expect((exact as { text: string }).text).toBe('y'.repeat(cap));
  });
});

describe.if(hasDom)('pinpoint click-to-pin flow', () => {
  async function mountViewer(options: {
    mode: 'selection' | 'redline';
    onAdd: (ann: Annotation) => void;
  }) {
    if (!htmlViewerModule) throw new Error('DOM test environment is not registered');
    const HtmlViewer = htmlViewerModule.HtmlViewer;
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    mountedRoots.push(root);
    await act(async () => {
      root.render(
        <HtmlViewer
          rawHtml="<html><body><p>Pinpoint target</p></body></html>"
          annotations={[]}
          onAddAnnotation={options.onAdd}
          onSelectAnnotation={() => {}}
          selectedAnnotationId={null}
          mode={options.mode}
          inputMethod="pinpoint"
        />,
      );
    });
    const iframe = host.querySelector<HTMLIFrameElement>('iframe');
    if (!iframe?.contentWindow) throw new Error('HTML iframe missing');
    const postSelection = async (data: Record<string, unknown>) => {
      await act(async () => {
        window.dispatchEvent(new MessageEvent('message', {
          source: iframe.contentWindow,
          data,
        }));
      });
    };
    return { postSelection };
  }

  const selectionMessage = {
    type: 'plannotator-bridge-selection',
    text: 'Pinpoint target',
    rect: { top: 10, left: 10, width: 120, height: 24 },
    anchor: { selector: 'p:nth-of-type(1)', tagName: 'p', text: 'Pinpoint target' },
  };

  test('a pinpoint selection opens the comment composer, not the toolbar', async () => {
    const { postSelection } = await mountViewer({ mode: 'selection', onAdd: () => {} });
    await postSelection({ ...selectionMessage, pinpoint: true });
    expect(document.querySelector('[data-comment-popover]')).not.toBeNull();
    expect(document.querySelector('.annotation-toolbar')).toBeNull();
  });

  test('a plain drag selection still opens the markup toolbar', async () => {
    const { postSelection } = await mountViewer({ mode: 'selection', onAdd: () => {} });
    await postSelection({ ...selectionMessage, anchor: undefined });
    expect(document.querySelector('.annotation-toolbar')).not.toBeNull();
    expect(document.querySelector('[data-comment-popover]')).toBeNull();
  });

  test('redline pinpoint commits an annotation carrying the element anchor', async () => {
    const added: Annotation[] = [];
    const { postSelection } = await mountViewer({
      mode: 'redline',
      onAdd: (ann) => added.push(ann),
    });
    await postSelection({ ...selectionMessage, pinpoint: true });
    expect(added.length).toBe(1);
    expect(added[0]!.originalText).toBe('Pinpoint target');
    expect(added[0]!.htmlAnchor).toEqual({
      selector: 'p:nth-of-type(1)',
      tagName: 'p',
      text: 'Pinpoint target',
    });
  });

  test('a selection with a malformed anchor commits without one', async () => {
    const added: Annotation[] = [];
    const { postSelection } = await mountViewer({
      mode: 'redline',
      onAdd: (ann) => added.push(ann),
    });
    await postSelection({
      ...selectionMessage,
      anchor: { selector: 'x'.repeat(2000), tagName: 'p' },
      pinpoint: true,
    });
    expect(added.length).toBe(1);
    expect(added[0]!.htmlAnchor).toBeUndefined();
  });
});
