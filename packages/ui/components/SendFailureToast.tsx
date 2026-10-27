import { useState } from 'react';
import { toast } from 'sonner';
import { copyTextToClipboard } from '../utils/clipboard';
import { describeSendFailure, sendFailureOf } from '../utils/sendFailure';

/**
 * The one message a review page shows when a decision did not reach the
 * agent (#1392): which decision, why, Retry, and Copy feedback. It stays until
 * dismissed (the person may not be looking when it fails) and a second
 * failure replaces it rather than stacking. The page itself is untouched:
 * the handlers that call this keep every annotation and never show a
 * "sent" screen.
 */

export const SEND_FAILURE_TOAST_ID = 'plannotator-send-failure';

/** Each failure gets a fresh Copy button (a repeat must not read "Copied"). */
let failures = 0;

/**
 * Copy feedback stays inside the toast after a click (a plain sonner `cancel`
 * button would close it and take the failure message with it). The data
 * attributes give it sonner's own secondary-button shape; the colors come
 * from the theme, since the Toasters run sonner's light theme and its
 * secondary fill disappears on a dark card.
 */
function CopyFeedbackButton({ text }: { text: string }) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
  return (
    <button
      type="button"
      data-button=""
      data-cancel=""
      data-send-failure-copy=""
      className="!bg-foreground/10 !text-foreground"
      onClick={() => {
        void copyTextToClipboard(text).then((copied) => setState(copied ? 'copied' : 'failed'));
      }}
    >
      {state === 'copied' ? 'Copied' : state === 'failed' ? 'Copy failed' : 'Copy feedback'}
    </button>
  );
}

export function showSendFailureToast(options: {
  /** What did not go out: names the toast's title. */
  what: 'feedback' | 'approval';
  /** The error the send threw (`DecisionSendError` says why). */
  error: unknown;
  /** Sends the same decision again. */
  onRetry: () => void;
  /** The text the failed send carried, as the page's Copy feedback copies it.
   *  Omitted when there was nothing to copy (a bare approval). */
  copyText?: string;
}): void {
  const { what, error, onRetry, copyText } = options;
  toast.error(what === 'approval' ? 'Approval not sent' : 'Feedback not sent', {
    id: SEND_FAILURE_TOAST_ID,
    description: describeSendFailure(sendFailureOf(error)),
    duration: Infinity,
    // It stays up, so it sits at the bottom, clear of the header's decision
    // control and the annotation panel the reviewer may want to read.
    position: 'bottom-center',
    closeButton: true,
    // Always set, even to undefined: sonner merges an update into the toast
    // with the same id, so an omitted key would keep the previous failure's
    // Copy button and its text.
    cancel: copyText ? <CopyFeedbackButton key={++failures} text={copyText} /> : undefined,
    action: { label: 'Retry', onClick: onRetry },
    classNames: { toast: '!w-auto', description: '!text-foreground/70' },
  });
}

/** A later send succeeded: the failure no longer applies. */
export function dismissSendFailureToast(): void {
  toast.dismiss(SEND_FAILURE_TOAST_ID);
}
