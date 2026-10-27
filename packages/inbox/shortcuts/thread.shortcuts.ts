import { defineShortcutScope } from '@plannotator/ui/shortcuts';

/**
 * The thread's keys. Mark read and Undo (App.tsx) also act on the list's
 * focused row; the rest act on the open thread (Thread.tsx). Every single key
 * stands down while typing, while an input method composes, under a dialog or
 * menu, and when single-key shortcuts are off (guards.ts `bareKeyAllowed`).
 */
export const inboxThreadShortcuts = defineShortcutScope({
  id: 'inbox-thread',
  title: 'Thread',
  shortcuts: {
    markRead: {
      description: 'Mark read, or move back',
      bindings: ['E'],
      section: 'List',
      hint: 'The row the keyboard is on, else the open thread. Only where something waits on you.',
      preventDefault: true,
      displayOrder: 5,
    },
    undo: {
      description: 'Undo',
      bindings: ['Z'],
      section: 'List',
      hint: 'While the toast shows Undo.',
      preventDefault: true,
      displayOrder: 6,
    },
    reply: {
      description: 'Reply',
      bindings: ['R'],
      section: 'Thread',
      hint: 'Opens the reply box (or the kept draft) with the caret in it. From a file too.',
      preventDefault: true,
      displayOrder: 0,
    },
    send: {
      // The reply box's and compose's own keydown (Thread.tsx, ComposeDialog.tsx) match this binding.
      description: 'Send',
      bindings: ['Mod+Enter'],
      section: 'Thread',
      hint: 'In the reply box or a new message.',
      preventDefault: true,
      displayOrder: 1,
    },
    nextMessage: {
      description: 'Next message',
      bindings: ['J'],
      section: 'Thread',
      hint: 'From the list too: focus moves into the open thread.',
      preventDefault: true,
      displayOrder: 2,
    },
    previousMessage: {
      description: 'Previous message',
      bindings: ['K'],
      section: 'Thread',
      preventDefault: true,
      displayOrder: 3,
    },
    firstNew: {
      description: 'First new message',
      bindings: ['N'],
      section: 'Thread',
      preventDefault: true,
      displayOrder: 4,
    },
    openNewest: {
      description: 'Open the newest file',
      bindings: ['O'],
      section: 'Thread',
      hint: 'In the view you last chose; then ] and [ step through the others.',
      preventDefault: true,
      displayOrder: 5,
    },
    close: {
      // App.tsx: a guided review, then the Artifacts view, then the thread.
      description: 'Close, one layer at a time',
      bindings: ['Escape'],
      section: 'Everywhere',
      displayOrder: 9,
    },
  },
});
