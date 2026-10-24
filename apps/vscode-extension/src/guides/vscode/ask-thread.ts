/**
 * The question box under the selected lines (approved 2026-10-23, variant 1):
 * a VS Code comment thread inserted below the selection in a guide diff. Its
 * first comment, from Plannotator, says what is asked about and what goes with
 * the question, with suggestions and earlier questions as links; the reply
 * field takes the question (Ask, Cancel), and the header's gear picks the
 * agent, model and effort. After Ask the same thread holds the question and
 * the agent's progress, then a link to the answer page, which opens in its own
 * tab beside the diff; follow-ups are asked in the same thread.
 *
 * Threads belong to the open guide and are not saved: closing the guide, or a
 * window reload, removes them. VS Code lists them in its Comments panel too.
 */

import * as vscode from "vscode";
import type { AnswerRecord, AskAbout } from "../ask/answers";
import type { AskRun } from "../ask/session";
import {
  THREAD_LINK_COMMANDS,
  THREAD_SUGGESTIONS,
  doneMarkdown,
  introMarkdown,
  modelEffort,
  threadLabel,
  workingMarkdown,
  type PastQuestion,
} from "../ask/thread-view";
import type { AgentChoiceRecord, LoadedGuide } from "../store";

/**
 * Two controllers, because VS Code gives a controller's text fields one set of words: a new box
 * asks a question, and once its first question runs the box moves (same lines) to the second
 * controller, whose field asks a follow-up. package.json matches both by `plannotator-guides-ask`.
 */
export const ASK_THREAD_CONTROLLER = "plannotator-guides-ask";
export const ASK_THREAD_CONVERSATION_CONTROLLER = "plannotator-guides-ask-conversation";
/** contextValue of a thread: what its reply field's buttons are (package.json `comments/commentThread/context`). */
export const ASK_THREAD_STATE = {
  compose: "plannotator-ask-compose",
  asking: "plannotator-ask-asking",
  done: "plannotator-ask-done",
} as const;

/** What a thread hears from the ask it started. */
export interface AskThreadSink {
  started(record: AnswerRecord, run: AskRun): void;
  /** The run ended (`opened`: its answer tab was opened beside the diff). */
  ended(record: AnswerRecord, opened: boolean): void;
}

export type ThreadAskResult = { started: true } | { started: false; reason?: string };

/** What the threads need from the rest of "Ask the agent". */
export interface ThreadAsker {
  /** The guide open in the reader, or null. */
  guide(): LoadedGuide | null;
  choiceFor(guide: LoadedGuide): AgentChoiceRecord;
  /** The gear: pick another agent, model or effort for this guide's questions. */
  changeChoice(guide: LoadedGuide): Promise<AgentChoiceRecord | null>;
  /** Earlier questions to offer ("Asked before"). */
  pastFor(guide: LoadedGuide, about: AskAbout): PastQuestion[];
  ask(guide: LoadedGuide, about: AskAbout, question: string, sink: AskThreadSink, followUpOf?: string): Promise<ThreadAskResult>;
  stop(answerId: string): Promise<void>;
  /** The reader's name for their own comments ("Michael Ramos"; "You" without one). */
  userName(): string;
  log(line: string): void;
}

interface Exchange {
  record: AnswerRecord;
  run?: AskRun;
  ended: boolean;
  opened: boolean;
}

interface Entry {
  id: string;
  guideId: string;
  about: AskAbout;
  thread: vscode.CommentThread;
  exchanges: Exchange[];
  /** A question sent, before its run started. */
  pending?: { question: string; at: number };
  notAsked?: { question: string; reason: string } | null;
}

const MAX_QUESTION = 2000;
/** How long after it is made the box's text field is focused (VS Code draws the box first). */
export const FOCUS_DELAY_MS = 400;
const ENABLED_COMMANDS = Object.values(THREAD_LINK_COMMANDS);

export class AskThreads implements vscode.Disposable {
  private readonly controller: vscode.CommentController;
  private readonly conversations: vscode.CommentController;
  private readonly entries = new Map<string, Entry>();
  private next = 1;
  private timer: ReturnType<typeof setInterval> | undefined;
  private readonly dirty = new Set<string>();
  private flush: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly asker: ThreadAsker, private readonly icons: { plannotator?: vscode.Uri; agent?(agentId: string): vscode.Uri | undefined } = {}) {
    this.controller = vscode.comments.createCommentController(ASK_THREAD_CONTROLLER, "Ask the agent");
    this.controller.options = { prompt: "Ask a question…", placeHolder: "Ask a question about these lines" };
    this.conversations = vscode.comments.createCommentController(ASK_THREAD_CONVERSATION_CONTROLLER, "Ask the agent");
    this.conversations.options = { prompt: "Ask a follow-up…", placeHolder: "Ask a follow-up; it continues this conversation" };
  }

  /** Open a question box under `range` of `uri` (a side of a guide diff). */
  open(guide: LoadedGuide, about: AskAbout, uri: vscode.Uri, range: vscode.Range, focus?: () => Promise<void>): void {
    // An unasked box on the same lines is reused; other unasked boxes go (one empty box at a time).
    for (const e of [...this.entries.values()]) {
      if (e.exchanges.length || e.pending) continue;
      if (e.guideId === guide.id && e.thread.uri.toString() === uri.toString() && e.thread.range?.isEqual(range)) {
        e.about = about;
        e.notAsked = null;
        this.render(e);
        e.thread.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
        if (focus) void focus().catch(() => undefined);
        return;
      }
      this.remove(e);
    }
    const id = `t${this.next++}`;
    const thread = this.controller.createCommentThread(uri, range, []);
    const entry: Entry = { id, guideId: guide.id, about, thread, exchanges: [] };
    this.entries.set(id, entry);
    thread.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
    this.render(entry);
    // Into its text field, as VS Code does for a comment it starts itself (an extension's thread
    // opens with its field collapsed): after the box is drawn, focus it, then its field.
    if (focus) {
      setTimeout(() => {
        if (this.entries.get(id) === entry && !entry.exchanges.length && !entry.pending) void focus().catch((err) => this.asker.log(`[guides] focusing the question box: ${err}`));
      }, FOCUS_DELAY_MS);
    }
  }

  private entryOf(arg: unknown): Entry | undefined {
    if (typeof arg === "string") return this.entries.get(arg);
    const thread = arg && typeof arg === "object" && "thread" in arg ? (arg as vscode.CommentReply).thread : (arg as vscode.CommentThread | undefined);
    for (const e of this.entries.values()) if (e.thread === thread) return e;
    return undefined;
  }

  // ---------------------------------------------------------------------------
  // Commands
  // ---------------------------------------------------------------------------

  /** The reply field's Ask: the typed question (a first question, or a follow-up). */
  async submit(reply: unknown): Promise<void> {
    const entry = this.entryOf(reply);
    if (!entry) return;
    const text = reply && typeof reply === "object" && "text" in reply ? String((reply as vscode.CommentReply).text ?? "") : "";
    const question = text.trim().slice(0, MAX_QUESTION);
    if (!question) {
      void vscode.window.showInformationMessage("Type a question, or pick one of the suggestions.");
      return;
    }
    await this.askIn(entry, question);
  }

  /** A suggestion link in the first comment. */
  async pick(threadId: unknown, index: unknown): Promise<void> {
    const entry = this.entryOf(threadId);
    const question = typeof index === "number" ? THREAD_SUGGESTIONS[index] : undefined;
    if (entry && question) await this.askIn(entry, question);
  }

  /** "Ask it now" after a question was not asked. */
  async again(threadId: unknown): Promise<void> {
    const entry = this.entryOf(threadId);
    const question = entry?.notAsked?.question;
    if (entry && question) await this.askIn(entry, question);
  }

  /** Cancel (an unasked box) and Close (after an answer): the box goes. */
  close(arg: unknown): void {
    const entry = this.entryOf(arg);
    if (entry) this.remove(entry);
  }

  /** The gear in the header. */
  async settings(arg: unknown): Promise<void> {
    const entry = this.entryOf(arg);
    const guide = this.asker.guide();
    if (!entry || !guide || guide.id !== entry.guideId) return;
    await this.asker.changeChoice(guide);
    for (const e of this.entries.values()) this.render(e);
  }

  async stop(answerId: unknown): Promise<void> {
    if (typeof answerId === "string") await this.asker.stop(answerId);
  }

  // ---------------------------------------------------------------------------

  private async askIn(entry: Entry, question: string): Promise<void> {
    const guide = this.asker.guide();
    if (!guide || guide.id !== entry.guideId) {
      void vscode.window.showInformationMessage("Open the guide this question box belongs to, then ask.");
      return;
    }
    if (entry.pending || entry.exchanges.some((x) => !x.ended)) return;
    const last = entry.exchanges[entry.exchanges.length - 1];
    entry.pending = { question, at: Date.now() };
    entry.notAsked = null;
    this.render(entry);
    let result: ThreadAskResult;
    try {
      result = await this.asker.ask(guide, entry.about, question, this.sinkFor(entry), last?.record.id);
    } catch (err) {
      result = { started: false, reason: err instanceof Error ? err.message : String(err) };
    }
    if (!result.started) {
      entry.pending = undefined;
      entry.notAsked = { question, reason: result.reason ?? "It was not sent." };
      this.render(entry);
    }
  }

  private sinkFor(entry: Entry): AskThreadSink {
    return {
      started: (record, run) => {
        if (!this.entries.has(entry.id)) return;
        entry.pending = undefined;
        if (!entry.exchanges.length) this.moveToConversation(entry);
        entry.exchanges.push({ record, run, ended: false, opened: false });
        run.onChange(() => this.mark(entry));
        this.render(entry);
        this.tick();
      },
      ended: (record, opened) => {
        const x = entry.exchanges.find((e) => e.record.id === record.id);
        if (!x || !this.entries.has(entry.id)) return;
        x.record = record;
        x.ended = true;
        x.opened = opened;
        x.run = undefined;
        this.render(entry);
        this.tick();
      },
    };
  }

  /** The first question runs: the box moves to the conversation controller (its field asks a follow-up). */
  private moveToConversation(entry: Entry): void {
    const old = entry.thread;
    const range = old.range ?? new vscode.Range(0, 0, 0, 0);
    entry.thread = this.conversations.createCommentThread(old.uri, range, []);
    entry.thread.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
    old.dispose();
  }

  /** Re-render a thread soon (the run changes often while the agent writes). */
  private mark(entry: Entry): void {
    this.dirty.add(entry.id);
    this.flush ??= setTimeout(() => {
      this.flush = undefined;
      for (const id of this.dirty) {
        const e = this.entries.get(id);
        if (e) this.render(e);
      }
      this.dirty.clear();
    }, 250);
  }

  /** The clock in a working comment: once a second while any thread is answering. */
  private tick(): void {
    const running = [...this.entries.values()].some((e) => e.exchanges.some((x) => !x.ended));
    if (running && !this.timer) {
      this.timer = setInterval(() => {
        for (const e of this.entries.values()) if (e.exchanges.some((x) => !x.ended)) this.render(e);
      }, 1000);
    } else if (!running && this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  private render(entry: Entry): void {
    const guide = this.asker.guide();
    const choice = guide && guide.id === entry.guideId ? this.asker.choiceFor(guide) : entry.exchanges[0]?.record.agent;
    const agentLabel = choice?.label ?? "the agent";
    const asked = entry.exchanges.length > 0 || !!entry.pending;
    const running = !!entry.pending || entry.exchanges.some((x) => !x.ended);
    const thread = entry.thread;
    thread.label = threadLabel(agentLabel, entry.about, asked);
    thread.contextValue = !asked ? ASK_THREAD_STATE.compose : running ? ASK_THREAD_STATE.asking : ASK_THREAD_STATE.done;
    thread.canReply = !running;
    const comments: vscode.Comment[] = [];
    if (!asked || entry.notAsked) {
      const past = guide && guide.id === entry.guideId ? this.asker.pastFor(guide, entry.about) : [];
      comments.push(this.comment(introMarkdown({ threadId: entry.id, about: entry.about, past, notAsked: entry.notAsked ?? null }), { name: "Plannotator", ...(this.icons.plannotator && { iconPath: this.icons.plannotator }) }, choice ? modelEffort(choice) : undefined));
    }
    const now = Date.now();
    for (const x of entry.exchanges) {
      comments.push(this.question(x.record.question, x.record.askedAt));
      const body = x.ended || !x.run
        ? doneMarkdown({ record: x.record, opened: x.opened })
        : workingMarkdown({ agentLabel: x.record.agent.label, answerId: x.record.id, state: x.run.state, now });
      comments.push(this.comment(body, this.agentAuthor(x.record.agent), modelEffort(x.record.agent), x.record.askedAt));
    }
    if (entry.pending) {
      comments.push(this.question(entry.pending.question, entry.pending.at));
      comments.push(this.comment(`$(loading~spin) **Getting ${agentLabel} ready…**`, this.agentAuthor(choice ?? { id: "", label: agentLabel }), choice ? modelEffort(choice) : undefined, entry.pending.at));
    }
    // After Ask, the box's own first comment goes; an unasked question brings it back.
    if (asked && entry.notAsked) comments.push(...comments.splice(0, 1));
    thread.comments = comments;
  }

  private agentAuthor(agent: Pick<AgentChoiceRecord, "id" | "label">): vscode.CommentAuthorInformation {
    const icon = agent.id ? this.icons.agent?.(agent.id) : undefined;
    return { name: agent.label, ...(icon && { iconPath: icon }) };
  }

  private question(text: string, at: number): vscode.Comment {
    const body = new vscode.MarkdownString();
    body.appendText(text);
    return { body, mode: vscode.CommentMode.Preview, author: { name: this.asker.userName() }, timestamp: new Date(at) };
  }

  private comment(markdown: string, author: vscode.CommentAuthorInformation, label?: string, at?: number): vscode.Comment {
    const body = new vscode.MarkdownString(markdown, true);
    body.isTrusted = { enabledCommands: ENABLED_COMMANDS };
    return { body, mode: vscode.CommentMode.Preview, author, ...(label && { label }), ...(at && { timestamp: new Date(at) }) };
  }

  private remove(entry: Entry): void {
    this.entries.delete(entry.id);
    entry.thread.dispose();
    this.tick();
  }

  /** The guide closed, another opened, or it was deleted: its boxes go. */
  keepOnly(guideId: string | null): void {
    for (const e of [...this.entries.values()]) if (e.guideId !== guideId) this.remove(e);
  }

  /** How many boxes there are (tests). */
  get size(): number {
    return this.entries.size;
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.flush) clearTimeout(this.flush);
    for (const e of this.entries.values()) e.thread.dispose();
    this.entries.clear();
    this.controller.dispose();
    this.conversations.dispose();
  }
}
