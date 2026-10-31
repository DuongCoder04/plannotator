/**
 * When a load may ask for the one-time list options dialog (approval "inbox-list-options-intro"). What regresses: the
 * dialog on the same load as the tour or another one-time dialog, over a reply or another dialog, on a page that is
 * not the list, through the tailnet, on a short list, or before this load's other dialogs are decided.
 */
import { describe, expect, test } from 'bun:test';
import { listIntroMayAsk, listIntroWanted, type ListIntroLoad } from './listIntro';

const ready: ListIntroLoad = {
  due: true,
  local: true,
  listLoaded: true,
  firstRun: false,
  rows: 5,
  page: 'inbox',
  tourThisLoad: false,
  otherDialogThisLoad: false,
  othersSettled: true,
  updating: false,
};
const calm = { modal: false, replying: false };

describe('the list options dialog: when a load may ask for it', () => {
  test('an existing user on the list, everything else decided: asks', () => {
    expect(listIntroWanted(ready)).toBe(true);
    expect(listIntroMayAsk(ready, calm)).toBe(true);
  });

  test('never on a load with the tour, the sound or the agent-note dialog: not even wanted, so nothing waits on it', () => {
    for (const load of [{ ...ready, tourThisLoad: true }, { ...ready, otherDialogThisLoad: true }]) {
      expect(listIntroWanted(load)).toBe(false);
      expect(listIntroMayAsk(load, calm)).toBe(false);
    }
  });

  test('not due (a new user, or already shown), through the tailnet, on first run or before the list loads: never', () => {
    for (const load of [{ ...ready, due: false }, { ...ready, local: false }, { ...ready, firstRun: true }, { ...ready, listLoaded: false }]) {
      expect(listIntroWanted(load)).toBe(false);
    }
  });

  test('a list of fewer than three rows waits for a later load', () => {
    expect(listIntroWanted({ ...ready, rows: 2 })).toBe(false);
    expect(listIntroWanted({ ...ready, rows: 3 })).toBe(true);
  });

  test('wanted, but it waits: on Settings, the Board or a thread-less page, before the other dialogs settle, over an update, another dialog or a reply', () => {
    for (const page of ['settings', 'board', 'whats-new', 'tour']) expect(listIntroMayAsk({ ...ready, page }, calm)).toBe(false);
    expect(listIntroMayAsk({ ...ready, othersSettled: false }, calm)).toBe(false);
    expect(listIntroMayAsk({ ...ready, updating: true }, calm)).toBe(false);
    expect(listIntroMayAsk(ready, { modal: true, replying: false })).toBe(false);
    expect(listIntroMayAsk(ready, { modal: false, replying: true })).toBe(false);
    // Still wanted meanwhile: the notification lines keep waiting for it.
    expect(listIntroWanted({ ...ready, page: 'settings', othersSettled: false, updating: true })).toBe(true);
  });
});
