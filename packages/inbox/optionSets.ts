/**
 * A question's picture choices as a gallery of their own (approval
 * "inbox-image-swipe", 2026-10-28, "Option sets"): the zoom on a picture
 * choice opens the viewer over that question's choices only, in choice order
 * (A → B → C → D), stopping at the first and last. Embedded images and
 * attachments keep the thread-wide order (stepping.ts); the pill's sheet
 * still lists every file.
 *
 * The set rides the address (`&set=<message id>:<question key>`, App.tsx),
 * so a reload and the browser's Back keep it. Pure: what the viewer steps
 * through and what its caption says.
 */

import type { InboxMessageWire } from '@plannotator/core/inbox-types';
import type { AttachmentStep } from './stepping';

/** One choice of the set, as the caption names it. */
export interface OptionSetChoice {
  /** The choice's label, the answer ("Gmail-style ⋯"). */
  label: string;
  /** "A", "B", …: its place among the question's choices. */
  letter: string;
  /** The label already starts with its letter ("B · Total pinned"): the caption draws no letter chip of its own. */
  lettered: boolean;
  recommended: boolean;
  /** The file the picture was captured as (its step in the thread). */
  attachmentId: string;
}

/** A question's picture choices, in choice order, with what the viewer steps through. */
export interface OptionSet {
  /** `<message id>:<question key>`, the address's `set=`. */
  id: string;
  messageId: string;
  questionKey: string;
  /** The question's prompt, for the caption's second line. */
  prompt: string;
  choices: OptionSetChoice[];
  /** The thread's steps for those choices, in choice order: what the viewer steps through. */
  steps: AttachmentStep[];
}

/** The address's `set=` for a question of a message. */
export function optionSetId(messageId: string, questionKey: string): string {
  return `${messageId}:${questionKey}`;
}

/** A `set=` read back: the message and the question key (null when it is not one). */
export function parseOptionSetId(id: string | null | undefined): { messageId: string; questionKey: string } | null {
  if (!id) return null;
  const at = id.indexOf(':');
  if (at <= 0 || at === id.length - 1) return null;
  return { messageId: id.slice(0, at), questionKey: id.slice(at + 1) };
}

/** "A" for the first choice, then "B", … ("27" past Z). */
export function choiceLetter(index: number): string {
  return index < 26 ? String.fromCharCode(65 + index) : String(index + 1);
}

/**
 * Whether a label already starts with its own letter as a token ("B · Total
 * pinned", "B) Tabs", "B"). A word that only starts with the letter ("A great
 * idea", "Bold") does not.
 */
export function labelHasLetter(label: string, letter: string): boolean {
  const trimmed = label.trim();
  if (!trimmed.startsWith(letter)) return false;
  const rest = trimmed.slice(letter.length);
  return rest === '' || /^\s*[·.:)\-–—]/.test(rest);
}

/** A picture choice's name in a viewer: "B · Quiet hover menu" ("B · Total pinned" when the label already leads with its letter). */
export function choiceName(label: string, index: number): string {
  const letter = choiceLetter(index);
  return labelHasLetter(label, letter) ? label.trim() : `${letter} · ${label}`;
}

/**
 * The set a `set=` names, out of the thread's messages and its steps (every
 * file in thread order): the question's choices that have a picture the
 * thread captured, in choice order, each once. Null when the message, the
 * question or every picture is missing, or only one picture is there (one
 * picture is not a set: the viewer steps through the thread as before).
 */
export function optionSetOf(messages: readonly InboxMessageWire[], steps: readonly AttachmentStep[], id: string | null | undefined): OptionSet | null {
  const at = parseOptionSetId(id);
  if (!at) return null;
  const message = messages.find((m) => m.id === at.messageId);
  const question = message?.questions?.find((q) => q.key === at.questionKey);
  if (!message || !question) return null;
  const choices: OptionSetChoice[] = [];
  const setSteps: AttachmentStep[] = [];
  question.choices.forEach((choice, index) => {
    if (!choice.image) return;
    const step = steps.find((s) => s.messageId === message.id && s.inline && s.attachment.ref === choice.image!.src);
    if (!step || setSteps.includes(step)) return;
    const letter = choiceLetter(index);
    setSteps.push(step);
    choices.push({ label: choice.label, letter, lettered: labelHasLetter(choice.label, letter), recommended: choice.recommended, attachmentId: step.attachment.id });
  });
  if (setSteps.length < 2) return null;
  return { id: optionSetId(message.id, question.key), messageId: message.id, questionKey: question.key, prompt: question.prompt, choices, steps: setSteps };
}

/** The choice a file is in the set (by its own id or the twin record folded into its step); null when it is not one of them. */
export function optionOf(set: OptionSet, attachmentId: string): { choice: OptionSetChoice; index: number } | null {
  const index = set.steps.findIndex((s) => s.attachment.id === attachmentId || (s.alsoIds?.includes(attachmentId) ?? false));
  return index < 0 ? null : { choice: set.choices[index]!, index };
}

export const LAST_OPTION_NOTE = 'Last option';
export const FIRST_OPTION_NOTE = 'First option';

/** "Option B of 4: Quiet hover menu, recommended": what a step inside a set says to a screen reader. */
export function optionAnnouncement(set: OptionSet, index: number): string {
  const choice = set.choices[index];
  if (!choice) return '';
  return `Option ${choice.letter} of ${set.choices.length}: ${choice.label}${choice.recommended ? ', recommended' : ''}`;
}

/**
 * The caption's last line at an end of the set: the end note, and at the
 * last option where the thread's other files are ("Last option · the
 * thread's 7 other files are under 4/4 ⌄"). Null in between, or at the first
 * option until a swipe past it says so.
 */
export function optionEndLine(set: OptionSet, index: number, otherFiles: number, note: string | null): { note: string; others: number } | null {
  const last = index === set.steps.length - 1;
  if (last) return { note: LAST_OPTION_NOTE, others: otherFiles };
  if (index === 0 && note === FIRST_OPTION_NOTE) return { note: FIRST_OPTION_NOTE, others: 0 };
  return null;
}
