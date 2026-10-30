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
  /** The window is phone-sized: the sheet's rows are 44 px touch targets in readable type. */
  phone?: boolean;
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

/** What can take focus inside the sheet, in order: Tab wraps among these while it is open. */
const SHEET_FOCUSABLE = 'button:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])';

/**
 * A button over the file opens the list as a sheet over the window; a pick scrolls there and closes it.
 * The sheet is modal while open: Tab wraps inside it, and Escape closes it first wherever focus is (before
 * full screen's Escape ladder sees the key). Focus goes back to the Contents button.
 */
function ContentsSheet(props: Props) {
  const [open, setOpen] = useState(false);
  const openRef = useRef<HTMLButtonElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const sheetRef = useRef<HTMLDivElement>(null);
  const wasOpen = useRef(false);
  useEffect(() => {
    if (open) closeRef.current?.focus({ preventScroll: true });
    else if (wasOpen.current) openRef.current?.focus({ preventScroll: true });
    wasOpen.current = open;
  }, [open]);
  useEffect(() => {
    if (!open) return;
    // The window's capture phase runs before the pane's ladder and the shortcut scopes (AnnotationsChip's way).
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        if (event.defaultPrevented) return;
        event.preventDefault();
        event.stopPropagation();
        setOpen(false);
        return;
      }
      const sheet = sheetRef.current;
      if (event.key !== 'Tab' || !sheet) return;
      const items = [...sheet.querySelectorAll<HTMLElement>(SHEET_FOCUSABLE)];
      const first = items[0];
      const last = items[items.length - 1];
      if (!first || !last) return;
      const active = document.activeElement;
      const inside = active instanceof Node && sheet.contains(active) && active !== sheet;
      if (event.shiftKey ? !inside || active === first : !inside || active === last) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus({ preventScroll: true });
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
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
              ref={sheetRef}
              className={`ib-contents ib-contents-sheet${props.phone ? ' ib-contents-phone' : ''}`}
              data-contents="sheet"
              role="dialog"
              aria-modal="true"
              aria-label="Contents"
              // A click on the sheet's blank space keeps focus in the sheet, not on the page behind it.
              tabIndex={-1}
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
