import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { Annotation, Block } from '@plannotator/ui/types';
import { DocumentContents } from '@plannotator/ui/components/DocumentContents';
import { Icon } from '../icons';
import { peekSheetHost } from './AttachmentStepper';
import { Tip } from './Tip';

/**
 * Where an open document's Contents list is drawn (SCOPE: inbox-contents-rail):
 * - `rail`: full screen on a wide window, a 240 px column on the left of the page;
 * - `column`: beside the thread, the top of the comments column, above Annotations;
 * - `sheet`: a narrow pane, a phone, or a narrow full screen: a button that opens the list over the file.
 */
export type ContentsPlacement = 'rail' | 'column' | 'sheet';

interface Props {
  placement: ContentsPlacement;
  blocks: Block[];
  annotations: Annotation[];
  /** The document's scroll element (`.ib-docscroll`). */
  scrollViewport: HTMLElement | null;
  /** The docked list (rail, column) is shown; the sheet ignores it. */
  shown: boolean;
  onShownChange: (shown: boolean) => void;
}

/** One document's Contents list in the Inbox window, in Inbox chrome around ui's DocumentContents. */
export function ContentsPanel(props: Props) {
  if (props.placement === 'sheet') return <ContentsSheet {...props} />;
  const list = <DocumentContents blocks={props.blocks} annotations={props.annotations} scrollViewport={props.scrollViewport} />;
  if (props.placement === 'column') {
    // Hidden, it folds to its header row, which shows it again.
    return (
      <section className="ib-contents ib-contents-col" data-contents="column" data-shown={props.shown ? '' : undefined} aria-label="Contents">
        <button type="button" className="ib-contents-h" aria-expanded={props.shown} onClick={() => props.onShownChange(!props.shown)} data-contents-toggle="">
          <span className="ib-contents-t">Contents</span>
          <Icon name={props.shown ? 'chevD' : 'chevR'} size={12} />
        </button>
        {props.shown && <div className="ib-contents-list">{list}</div>}
      </section>
    );
  }
  if (!props.shown) {
    return (
      <button type="button" className="ib-btn ib-sm ib-contents-open" onClick={() => props.onShownChange(true)} aria-label="Show contents" data-contents-show="">
        <Icon name="contents" size={14} />
        Contents
      </button>
    );
  }
  return (
    <aside className="ib-contents ib-contents-rail" data-contents="rail" aria-label="Contents">
      <div className="ib-contents-h">
        <span className="ib-contents-t">Contents</span>
        <Tip content="Hide contents">
          <button type="button" className="ib-iconbtn" onClick={() => props.onShownChange(false)} aria-label="Hide contents" data-contents-hide="">
            <Icon name="chevL" size={14} />
          </button>
        </Tip>
      </div>
      <div className="ib-contents-list">{list}</div>
    </aside>
  );
}

/** A button over the file opens the list as a sheet over the window; a pick scrolls there and closes it. */
function ContentsSheet(props: Props) {
  const [open, setOpen] = useState(false);
  const openRef = useRef<HTMLButtonElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const wasOpen = useRef(false);
  useEffect(() => {
    if (open) closeRef.current?.focus({ preventScroll: true });
    else if (wasOpen.current) openRef.current?.focus({ preventScroll: true });
    wasOpen.current = open;
  }, [open]);
  const host = open ? peekSheetHost(openRef.current) : null;
  return (
    <>
      <Tip content="Contents">
        <button
          ref={openRef}
          type="button"
          className="ib-iconbtn ib-contents-open"
          onClick={() => setOpen(true)}
          aria-label="Contents"
          aria-expanded={open}
          data-contents-open=""
        >
          <Icon name="contents" size={16} />
        </button>
      </Tip>
      {host &&
        createPortal(
          <>
            <button type="button" className="ib-contents-scrim" aria-label="Close contents" tabIndex={-1} onClick={() => setOpen(false)} />
            <div
              className="ib-contents ib-contents-sheet"
              data-contents="sheet"
              role="dialog"
              aria-label="Contents"
              onKeyDown={(event) => {
                if (event.key === 'Escape' && !event.defaultPrevented) {
                  event.preventDefault();
                  event.stopPropagation();
                  setOpen(false);
                }
              }}
            >
              <div className="ib-contents-h">
                <span className="ib-contents-t">Contents</span>
                <button ref={closeRef} type="button" className="ib-iconbtn" onClick={() => setOpen(false)} aria-label="Close contents">
                  <Icon name="x" size={16} />
                </button>
              </div>
              <div className="ib-contents-list">
                <DocumentContents
                  blocks={props.blocks}
                  annotations={props.annotations}
                  scrollViewport={props.scrollViewport}
                  onNavigate={() => setOpen(false)}
                />
              </div>
            </div>
          </>,
          host,
        )}
    </>
  );
}
