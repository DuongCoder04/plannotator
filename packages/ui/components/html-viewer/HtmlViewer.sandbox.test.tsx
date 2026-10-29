/**
 * HtmlViewer `sandbox` prop (DOM-gated).
 *
 * Guards: with no prop the srcdoc frame keeps `allow-scripts allow-modals`
 * (Plannotator's Inbox, annotate and review are unchanged); a host's value
 * is the frame's whole attribute, so `"allow-scripts"` blocks a shared page's
 * dialogs; `hostNavigates` still adds the `allow-popups` it needs, on either
 * value; and live-app `src` mode stays unsandboxed whatever is passed.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';

const hasDom = typeof document !== 'undefined';
const htmlViewerModule = hasDom ? await import('./HtmlViewer') : null;

const mountedRoots: Array<{ unmount: () => void }> = [];

afterEach(async () => {
  if (!hasDom) return;
  await act(async () => {
    for (const root of mountedRoots.splice(0)) root.unmount();
  });
  document.body.replaceChildren();
});

type MountProps = { sandbox?: string; hostNavigates?: boolean; src?: string };

async function frameFor(props: MountProps): Promise<HTMLIFrameElement> {
  if (!htmlViewerModule) throw new Error('DOM test environment is not registered');
  const HtmlViewer = htmlViewerModule.HtmlViewer;
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  mountedRoots.push(root);
  await act(async () => {
    root.render(
      <HtmlViewer
        rawHtml="<html><head><title>t</title></head><body><p>Target</p></body></html>"
        annotations={[]}
        onAddAnnotation={() => {}}
        onSelectAnnotation={() => {}}
        selectedAnnotationId={null}
        mode="selection"
        inputMethod="pinpoint"
        {...props}
      />,
    );
  });
  const frames = host.querySelectorAll<HTMLIFrameElement>('iframe');
  // One frame renders the document; a second copy would need the prop too.
  expect(frames.length).toBe(1);
  return frames[0];
}

describe.if(hasDom)('HtmlViewer sandbox', () => {
  test('with no prop the frame keeps allow-scripts allow-modals', async () => {
    const frame = await frameFor({});
    expect(frame.getAttribute('sandbox')).toBe('allow-scripts allow-modals');
  });

  test('sandbox="allow-scripts" is the whole attribute, with no allow-modals', async () => {
    const frame = await frameFor({ sandbox: 'allow-scripts' });
    expect(frame.getAttribute('sandbox')).toBe('allow-scripts');
  });

  test('hostNavigates adds allow-popups to the default and to a host value', async () => {
    expect((await frameFor({ hostNavigates: true })).getAttribute('sandbox'))
      .toBe('allow-scripts allow-modals allow-popups');
    expect((await frameFor({ hostNavigates: true, sandbox: 'allow-scripts' })).getAttribute('sandbox'))
      .toBe('allow-scripts allow-popups');
    expect((await frameFor({ hostNavigates: true, sandbox: 'allow-scripts allow-popups' })).getAttribute('sandbox'))
      .toBe('allow-scripts allow-popups');
  });

  test('live-app src mode stays unsandboxed when a sandbox is passed', async () => {
    const frame = await frameFor({ src: 'about:blank', sandbox: 'allow-scripts' });
    expect(frame.hasAttribute('sandbox')).toBe(false);
  });
});
