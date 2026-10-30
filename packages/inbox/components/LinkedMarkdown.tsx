import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Viewer, type ViewerHandle } from '@plannotator/ui/components/Viewer';
import { ImageResolverContext, type ImageResolver } from '@plannotator/ui/components/ImageResolverContext';
import { ScrollViewportProvider } from '@plannotator/ui/hooks/useScrollViewport';
import type { LinkedPageView } from '../api';
import { attachmentBlocks } from '../attachments';

const noop = () => {};

/** Sibling documents are read-only: annotations belong to attached files. */
export function LinkedMarkdown({ page, attachmentId, onOpenLink }: {
  page: LinkedPageView & { html: null; text: string; relative: string; hash: string };
  attachmentId: string;
  onOpenLink: (href: string) => void;
}) {
  const [viewport, setViewport] = useState<HTMLDivElement | null>(null);
  const viewer = useRef<ViewerHandle>(null);
  const blocks = useMemo(() => attachmentBlocks('markdown', page.text, page.name), [page.text, page.name]);
  const resolveImage = useCallback<ImageResolver>((src) => ({
    kind: 'src',
    src: /^(https?:|data:|blob:|\/\/)/i.test(src) ? src : `/api/inbox/attachments/${encodeURIComponent(attachmentId)}/markdown-image?document=${encodeURIComponent(page.relative)}&path=${encodeURIComponent(src)}`,
  }), [attachmentId, page.relative]);
  useEffect(() => {
    if (!viewport || !page.hash) return;
    viewer.current?.scrollToAnchor?.(page.hash);
  }, [viewport, page.hash, page.path]);
  return (
    <div className="ib-docscroll bg-card" data-look="clean" ref={setViewport}>
      <ScrollViewportProvider viewport={viewport}>
        <ImageResolverContext.Provider value={resolveImage}>
          <Viewer
            key={page.path}
            ref={viewer}
            blocks={blocks}
            markdown={page.text}
            annotations={[]}
            onAddAnnotation={noop}
            onSelectAnnotation={noop}
            selectedAnnotationId={null}
            resolveLocalLink={(href) => ({ kind: 'open', open: () => onOpenLink(href) })}
            questionDecisionLines={false}
            stickyActions={false}
            disableCodePathValidation
            maxWidth={760}
            mode="comment"
            taterMode={false}
            readOnly
          />
        </ImageResolverContext.Provider>
      </ScrollViewportProvider>
    </div>
  );
}
