/**
 * What the question box under the selected lines says (approved 2026-10-23,
 * "Ask from a box under the selected lines", variant 1): a VS Code comment
 * thread whose first comment, from Plannotator, names the lines and what goes
 * with the question, with suggestions and earlier questions as links. After
 * Ask, the same thread holds the question and the agent's progress, then a
 * link to the answer page. No `vscode` here: the bodies are markdown strings
 * the thread module puts in trusted MarkdownStrings.
 */

import type { AgentChoiceRecord } from "../store";
import type { AnswerRecord, AskAbout } from "./answers";
import type { AskRunState } from "./session";

/** The suggestions under the intro, in the mock's order. */
export const THREAD_SUGGESTIONS = [
  "Why did this change?",
  "What could break?",
  "How does this affect performance?",
  "Draw how this works",
  "Explain it like I'm new to this code",
] as const;

/** The commands the thread's links run (the trusted MarkdownString enables exactly these). */
export const THREAD_LINK_COMMANDS = {
  pick: "plannotator.guides.askThreadPick",
  open: "plannotator.guides.openAnswer",
  stop: "plannotator.guides.askThreadStop",
  again: "plannotator.guides.askThreadAgain",
} as const;

function base(path: string): string {
  return path.split("/").pop() ?? path;
}

function linesLabel(lines: { start: number; end: number }): string {
  return lines.start === lines.end ? `${lines.start}` : `${lines.start}–${lines.end}`;
}

/** "deliver.ts 25–31", "deliver.ts 25–31 (old)", "deliver.ts". */
export function threadWhere(about: AskAbout): string {
  if (!about.path) return `Chapter ${about.chapter + 1}`;
  if (about.kind === "selection" && about.lines) return `${base(about.path)} ${linesLabel(about.lines)}${about.side === "base" ? " (old)" : ""}`;
  return base(about.path);
}

/** The thread's header: "Ask Claude Code · deliver.ts 25–31", then "Claude Code · deliver.ts 25–31" once asked. */
export function threadLabel(agentLabel: string, about: AskAbout, asked: boolean): string {
  return `${asked ? agentLabel : `Ask ${agentLabel}`} · ${threadWhere(about)}`;
}

/** "Sonnet · low", beside the author's name. */
export function modelEffort(choice: Pick<AgentChoiceRecord, "model" | "effort">): string {
  return [choice.model?.label ?? "agent default", choice.effort?.label.toLowerCase()].filter(Boolean).join(" · ");
}

/** Escape text for a markdown paragraph (and a link's text). */
export function escapeMarkdown(text: string): string {
  return text.replace(/[\\`*_{}[\]()#!|<>~]/g, (c) => `\\${c}`).replace(/\r?\n/g, " ");
}

/** A `command:` link with JSON arguments, as VS Code reads them. */
export function commandLink(text: string, command: string, args: unknown[], title?: string): string {
  const uri = `command:${command}?${encodeURIComponent(JSON.stringify(args))}`;
  return `[${escapeMarkdown(text)}](${uri}${title ? ` "${title.replace(/["\\\r\n]/g, " ").slice(0, 200)}"` : ""})`;
}

/** "Ask about **lines 25–31**. The lines, the file's diff, Chapter 2 and the guide go with it." */
export function introSentence(about: AskAbout): string {
  const chapter = `Chapter ${about.chapter + 1}`;
  if (about.kind === "selection" && about.lines) {
    const one = about.lines.start === about.lines.end;
    const what = `${one ? "line" : "lines"} ${linesLabel(about.lines)}${about.side === "base" ? " of the old version" : ""}`;
    return `Ask about **${what}**. The ${one ? "line" : "lines"}, the file's diff, ${chapter} and the guide go with it.`;
  }
  if (about.path) return `Ask about **${escapeMarkdown(base(about.path))}**. The file and its diff, ${chapter} and the guide go with it.`;
  return `Ask about **${chapter}**. The chapter, its files' diffs and the guide go with it.`;
}

export interface PastQuestion {
  id: string;
  question: string;
  /** "yesterday", "2h". */
  when: string;
}

export interface IntroInput {
  threadId: string;
  about: AskAbout;
  past: PastQuestion[];
  /** A question that was typed but not asked (another one was being answered, the agent did not start). */
  notAsked?: { question: string; reason: string } | null;
}

/** The first comment: what is asked about, the suggestions, earlier questions. */
export function introMarkdown(input: IntroInput): string {
  const parts: string[] = [];
  parts.push(`${introSentence(input.about)} Or pick one:`);
  parts.push(THREAD_SUGGESTIONS.map((q, i) => commandLink(q, THREAD_LINK_COMMANDS.pick, [input.threadId, i], `Ask: ${q}`)).join(" · "));
  if (input.past.length) {
    const rows = input.past.map((p) => `${commandLink(p.question, THREAD_LINK_COMMANDS.open, [p.id], "Open its answer")} · ${p.when}`);
    parts.push(`Asked before: ${rows.join("  \n")}`);
  }
  if (input.notAsked) {
    parts.push(`Not asked: “${escapeMarkdown(input.notAsked.question)}”. ${escapeMarkdown(input.notAsked.reason)} ${commandLink("Ask it now", THREAD_LINK_COMMANDS.again, [input.threadId], "Ask this question again")}`);
  }
  return parts.join("\n\n");
}

function clock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** The files the agent's tool calls touched so far, newest last, at most three. */
export function filesRead(state: Pick<AskRunState, "activity">): string[] {
  const seen: string[] = [];
  for (const a of state.activity) {
    if (a.kind !== "tool") continue;
    for (const l of a.locations ?? []) {
      const name = base(l.path);
      const at = seen.indexOf(name);
      if (at >= 0) seen.splice(at, 1);
      seen.push(name);
    }
  }
  return seen.slice(-3);
}

/** The agent's comment while it answers: "Asking Claude Code… 0:06 · $0.01 · read worker.ts · Stop". */
export function workingMarkdown(input: { agentLabel: string; answerId: string; state: AskRunState; now: number }): string {
  const { state } = input;
  const stop = commandLink("Stop", THREAD_LINK_COMMANDS.stop, [input.answerId], "Stop answering");
  const pending = state.pendingPermissions[0];
  if (pending) {
    const review = commandLink("Review", THREAD_LINK_COMMANDS.open, [input.answerId], "Show the request in the answer tab");
    return `$(shield) **${escapeMarkdown(input.agentLabel)} needs your OK** · ${escapeMarkdown(pending.title)} · ${review} · ${stop}`;
  }
  const lead = state.status === "starting" ? `Starting ${input.agentLabel}…` : `Asking ${input.agentLabel}…`;
  const bits = [`$(loading~spin) **${escapeMarkdown(lead)}** ${clock(input.now - state.startedAt)}`];
  if (state.cost) bits.push(`$${state.cost.amount.toFixed(2)}`);
  const read = filesRead(state);
  if (read.length) bits.push(`read ${escapeMarkdown(read.join(", "))}`);
  bits.push(stop);
  return bits.join(" · ");
}

/** The agent's comment once it ended: where the answer is, or why there is none. */
export function doneMarkdown(input: { record: AnswerRecord; opened: boolean }): string {
  const { record } = input;
  const open = commandLink("Open", THREAD_LINK_COMMANDS.open, [record.id], record.title ? `Open “${record.title}”` : "Open the answer");
  switch (record.status) {
    case "answered":
    case "text":
      return `$(check) **Answer ${input.opened ? "opened beside the diff" : "ready"}** · ${open}`;
    case "stopped":
      return `$(debug-stop) **Stopped.** What it wrote so far is in the answer · ${open}`;
    case "failed":
      return `$(error) **No answer.** ${escapeMarkdown(record.statusMessage ?? "The agent stopped with an error.")} · ${open}`;
    default:
      return `$(question) ${escapeMarkdown(record.statusMessage ?? "No answer.")} · ${open}`;
  }
}
