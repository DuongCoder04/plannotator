/**
 * Qwen Code provider (registered as "qwen-sdk"): Ask AI answered by the
 * user's installed `qwen` CLI.
 *
 * One short-lived `qwen` process per question. `qwen -o stream-json` answers
 * one prompt and exits; the conversation lives in Qwen Code's own session
 * store. The first question starts it with `--session-id <uuid>`, later ones
 * continue it with `--resume <uuid>`.
 *
 * - The prompt goes on stdin, never argv: cmd.exe caps a command line at
 *   about 8 KB and the first question carries the whole review context.
 * - `--approval-mode plan` keeps the run read-only. `exit_plan_mode` is
 *   excluded: the Plannotator Qwen extension opens a plan review on it, and
 *   an Ask AI answer must never do that.
 * - `--max-wall-time` bounds the run; qwen exits with code 55 when it is
 *   over.
 *
 * Written with node:child_process, so this one file serves the Bun server
 * and the Pi extension (Node), like codex-app-server.ts.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { qwenCatalogFromSettings, type CatalogModel } from "@plannotator/core/model-catalog";
import { BaseSession } from "../base-session.ts";
import { buildEffectivePrompt, buildSystemPrompt } from "../context.ts";
import type {
	AIMessage,
	AIProvider,
	AIProviderCapabilities,
	CreateSessionOptions,
	QwenSDKConfig,
} from "../types.ts";
import { registerProviderFactory } from "../provider.ts";
import {
	buildWindowsCommandScriptSpawnCommand,
	killWindowsProcessTree,
	resolveWindowsCommandShim,
} from "./command-path.ts";
import { guardChildStreams, toChildError, writeChildLine } from "./child-io.ts";
import { mapQwenLine } from "./qwen-events.ts";

export { mapQwenLine } from "./qwen-events.ts";

const PROVIDER_NAME = "qwen-sdk";
const QWEN_PROCESS_LABEL = "Qwen process";
/** The run's wall-clock budget (qwen's `--max-wall-time`). */
const QWEN_MAX_WALL_TIME = "10m";
/** qwen's exit code when `--max-wall-time` ran out. */
const QWEN_WALL_TIME_EXIT = 55;
/** Kept from the end of stderr, to explain a run that failed. */
const STDERR_TAIL_CHARS = 4000;
/**
 * After its result line, qwen may still be writing the session it continues
 * next time. The next question waits this long for it to exit, then stops it.
 */
const PREVIOUS_RUN_GRACE_MS = 5_000;
/**
 * `close` (stdout drained) normally follows `exit`; a child qwen started and
 * left holding the pipe would delay it forever, so `exit` ends the run after
 * this long anyway.
 */
const EXIT_WITHOUT_CLOSE_MS = 1_000;

/**
 * The Qwen Code folder: `$QWEN_HOME` (`~` expanded, a relative path taken
 * from `cwd`, as qwen does), else `~/.qwen`.
 */
export function qwenHomeDir(
	env: NodeJS.ProcessEnv = process.env,
	home: string = homedir(),
	cwd: string = process.cwd(),
): string {
	const configured = env.QWEN_HOME?.trim();
	if (!configured) return join(home, ".qwen");
	if (configured === "~") return home;
	if (configured.startsWith("~/") || configured.startsWith("~\\")) {
		return join(home, configured.slice(2));
	}
	return resolve(cwd, configured);
}

/** Comments and trailing commas removed, strings kept (qwen reads its settings with comments allowed). */
function stripJsonComments(text: string): string {
	let out = "";
	let i = 0;
	while (i < text.length) {
		const ch = text[i]!;
		if (ch === '"') {
			let j = i + 1;
			while (j < text.length && text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
			out += text.slice(i, j + 1);
			i = j + 1;
			continue;
		}
		if (ch === "/" && text[i + 1] === "/") {
			while (i < text.length && text[i] !== "\n") i += 1;
			continue;
		}
		if (ch === "/" && text[i + 1] === "*") {
			const end = text.indexOf("*/", i + 2);
			i = end === -1 ? text.length : end + 2;
			continue;
		}
		out += ch;
		i += 1;
	}
	return out.replace(/,(\s*[}\]])/g, "$1");
}

/** The models in the user's Qwen Code settings; empty when there are none or the file cannot be read. */
export async function readQwenCatalog(qwenHome: string): Promise<CatalogModel[]> {
	try {
		const text = (await readFile(join(qwenHome, "settings.json"), "utf8")).replace(/^﻿/, "");
		return qwenCatalogFromSettings(JSON.parse(stripJsonComments(text)));
	} catch {
		return [];
	}
}

/** The error shown for a run that ended without a result line. */
export function qwenExitError(code: number | null, failure?: Error, stderrTail?: string): string {
	let message: string;
	if (code === QWEN_WALL_TIME_EXIT) {
		message = `Qwen Code stopped the run: it took longer than ${QWEN_MAX_WALL_TIME} (exit code ${QWEN_WALL_TIME_EXIT}).`;
	} else if (failure) {
		message = `Qwen Code could not run: ${failure.message}`;
	} else if (code == null) {
		message = "Qwen Code ended without an answer.";
	} else {
		message = `Qwen Code exited with code ${code} without an answer.`;
	}
	const tail = stderrTail?.trim();
	if (tail) message += ` Stderr: ${tail.slice(-500)}`;
	return message;
}

// ---------------------------------------------------------------------------
// One-shot process
// ---------------------------------------------------------------------------

type LineListener = (line: Record<string, unknown>) => void;
type EndListener = (code: number | null, failure?: Error) => void;

/** One `qwen` run. Exported for tests. */
export class QwenProcess {
	private proc: ChildProcess | null = null;
	private buffer = "";
	private stderrTail = "";
	private ended = false;
	private endWaiters: Array<() => void> = [];
	private lineListener: LineListener | null = null;
	private endListener: EndListener | null = null;

	get stderr(): string {
		return this.stderrTail;
	}

	get hasEnded(): boolean {
		return this.ended;
	}

	/**
	 * Start the run and write `prompt` to its stdin. A start or pipe failure
	 * is reported through `onEnd`, never thrown and never unhandled.
	 */
	start(
		qwenPath: string,
		args: string[],
		cwd: string,
		prompt: string,
		onLine: LineListener,
		onEnd: EndListener,
	): void {
		this.lineListener = onLine;
		this.endListener = onEnd;
		const commandPath = resolveWindowsCommandShim(qwenPath);
		const [file, ...rest] =
			buildWindowsCommandScriptSpawnCommand(commandPath, args) ?? [commandPath, ...args];
		let proc: ChildProcess;
		try {
			proc = spawn(file!, rest, {
				cwd,
				env: { ...process.env },
				stdio: ["pipe", "pipe", "pipe"],
				windowsHide: true,
			});
		} catch (err) {
			this.end(null, toChildError(err));
			return;
		}
		this.proc = proc;
		// Before anything else: a stream error with no listener would crash
		// the host process, not just this provider (#1378).
		guardChildStreams(proc, QWEN_PROCESS_LABEL, (error) => this.fail(error));
		proc.stdout?.on("data", (chunk: Buffer) => this.readChunk(chunk.toString()));
		// Drained in full: a stderr pipe nobody reads fills and stalls the child.
		proc.stderr?.on("data", (chunk: Buffer) => {
			this.stderrTail = (this.stderrTail + chunk.toString()).slice(-STDERR_TAIL_CHARS);
		});
		proc.once("close", (code) => this.end(code));
		proc.once("exit", (code) => {
			setTimeout(() => this.end(code), EXIT_WITHOUT_CLOSE_MS).unref?.();
		});

		const writeError = writeChildLine(proc, prompt, QWEN_PROCESS_LABEL, (error) => this.fail(error));
		if (writeError) {
			this.fail(writeError);
			return;
		}
		try {
			proc.stdin?.end();
		} catch (err) {
			this.fail(toChildError(err));
		}
	}

	private readChunk(text: string): void {
		this.buffer += text;
		const lines = this.buffer.split("\n");
		this.buffer = lines.pop() ?? "";
		for (const line of lines) this.emitLine(line);
	}

	private emitLine(raw: string): void {
		const line = raw.replace(/\r$/, "");
		if (!line) return;
		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch {
			return; // Not a JSON line (a stray log line).
		}
		if (parsed && typeof parsed === "object") this.lineListener?.(parsed as Record<string, unknown>);
	}

	private fail(error: Error): void {
		this.end(null, error);
		this.kill();
	}

	private end(code: number | null, failure?: Error): void {
		if (this.ended) return;
		this.ended = true;
		if (this.buffer) {
			const tail = this.buffer;
			this.buffer = "";
			this.emitLine(tail);
		}
		const listener = this.endListener;
		this.lineListener = null;
		this.endListener = null;
		listener?.(code, failure);
		for (const wake of this.endWaiters.splice(0)) wake();
	}

	/** Resolves once the run has ended, or after `ms` (then the run is stopped). */
	async settle(ms: number): Promise<void> {
		if (this.ended) return;
		await new Promise<void>((done) => {
			const timer = setTimeout(done, ms);
			this.endWaiters.push(() => {
				clearTimeout(timer);
				done();
			});
		});
		if (!this.ended) this.kill();
	}

	kill(): void {
		const proc = this.proc;
		if (!proc || proc.exitCode !== null || proc.signalCode !== null) return;
		try {
			if (!killWindowsProcessTree(proc.pid)) proc.kill();
		} catch {
			// Already gone.
		}
	}
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export class QwenSDKProvider implements AIProvider {
	readonly name = PROVIDER_NAME;
	readonly capabilities: AIProviderCapabilities = {
		fork: false,
		resume: true,
		streaming: true,
		tools: true,
	};
	models?: CatalogModel[];

	private config: QwenSDKConfig;
	private sessions = new Map<string, QwenSDKSession>();

	constructor(config: QwenSDKConfig) {
		this.config = config;
	}

	private sessionConfig(cwd: string): Pick<SessionConfig, "cwd" | "qwenExecutablePath"> {
		return { cwd, qwenExecutablePath: this.config.qwenExecutablePath ?? "qwen" };
	}

	async createSession(options: CreateSessionOptions): Promise<QwenSDKSession> {
		const session = new QwenSDKSession({
			...this.sessionConfig(options.cwd ?? this.config.cwd ?? process.cwd()),
			systemPrompt: buildSystemPrompt(options.context),
			model: options.model ?? this.config.model,
			maxTurns: options.maxTurns,
			resume: false,
		});
		this.sessions.set(session.id, session);
		return session;
	}

	async forkSession(): Promise<never> {
		throw new Error(
			"Qwen Code does not support session forking. " +
				"The endpoint layer should fall back to createSession().",
		);
	}

	/** Continue a Qwen Code session this provider started (its id is qwen's). */
	async resumeSession(sessionId: string): Promise<QwenSDKSession> {
		const session = new QwenSDKSession(
			{
				...this.sessionConfig(this.config.cwd ?? process.cwd()),
				systemPrompt: "",
				model: this.config.model,
				resume: true,
			},
			sessionId,
		);
		this.sessions.set(session.id, session);
		return session;
	}

	dispose(): void {
		for (const session of this.sessions.values()) session.killProcess();
		this.sessions.clear();
	}

	/** The models from the user's Qwen Code settings.json. Runs no `qwen`. */
	async fetchModels(): Promise<void> {
		const cwd = this.config.cwd ?? process.cwd();
		const models = await readQwenCatalog(qwenHomeDir(process.env, homedir(), cwd));
		if (models.length > 0) this.models = models;
	}
}

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------

interface SessionConfig {
	systemPrompt: string;
	cwd: string;
	qwenExecutablePath: string;
	model?: string;
	maxTurns?: number;
	/** The conversation already exists in Qwen Code's store. */
	resume: boolean;
}

class QwenSDKSession extends BaseSession {
	private config: SessionConfig;
	private child: QwenProcess | null = null;
	/**
	 * The Qwen Code session id. It starts as this session's id; a first
	 * question that got no answer at all gets a fresh one for the retry, since
	 * qwen may already have stored that id.
	 */
	private qwenSessionId: string;
	private conversationStarted: boolean;

	constructor(config: SessionConfig, initialId?: string) {
		super({ parentSessionId: null, ...(initialId ? { initialId } : {}) });
		this.config = config;
		this.qwenSessionId = this.id;
		this.conversationStarted = config.resume;
		this._firstQuerySent = config.resume;
	}

	private buildArgs(): string[] {
		const args = [
			this.conversationStarted ? "--resume" : "--session-id",
			this.qwenSessionId,
			"--output-format",
			"stream-json",
			"--include-partial-messages",
			"--approval-mode",
			"plan",
			"--exclude-tools=exit_plan_mode",
			"--max-wall-time",
			QWEN_MAX_WALL_TIME,
		];
		if (this.config.model) args.push("--model", this.config.model);
		if (this.config.maxTurns && this.config.maxTurns > 0) {
			args.push("--max-session-turns", String(this.config.maxTurns));
		}
		return args;
	}

	async *query(prompt: string): AsyncIterable<AIMessage> {
		const started = this.startQuery();
		if (!started) {
			yield BaseSession.BUSY_ERROR;
			return;
		}
		const { gen, signal } = started;

		const queue: AIMessage[] = [];
		let wake: (() => void) | null = null;
		let done = false;
		let answered = false;
		const push = (msg: AIMessage) => {
			queue.push(msg);
			wake?.();
		};
		const finish = () => {
			done = true;
			wake?.();
		};

		try {
			// The previous run may still be saving the conversation this one
			// continues.
			await this.child?.settle(PREVIOUS_RUN_GRACE_MS);
			if (signal.aborted) return;

			const child = new QwenProcess();
			this.child = child;
			const onAbort = () => {
				child.kill();
				finish();
			};
			signal.addEventListener("abort", onAbort, { once: true });

			child.start(
				this.config.qwenExecutablePath,
				this.buildArgs(),
				this.config.cwd,
				buildEffectivePrompt(prompt, this.config.systemPrompt, this.conversationStarted),
				(line) => {
					if (line.type === "system") return;
					answered = true;
					for (const msg of mapQwenLine(line, this.id)) {
						push(msg);
						if (msg.type === "result") finish();
					}
				},
				(code, failure) => {
					if (!done && !signal.aborted) {
						push({
							type: "error",
							error: qwenExitError(code, failure, child.stderr),
							code: "qwen_process_exit",
						});
					}
					finish();
				},
			);

			try {
				while (!done || queue.length > 0) {
					if (queue.length > 0) {
						yield queue.shift()!;
					} else {
						await new Promise<void>((r) => {
							wake = r;
						});
						wake = null;
					}
				}
			} finally {
				signal.removeEventListener("abort", onAbort);
			}
		} catch (err) {
			yield {
				type: "error",
				error: err instanceof Error ? err.message : String(err),
				code: "provider_error",
			};
		} finally {
			if (answered) {
				this.conversationStarted = true;
				this._firstQuerySent = true;
			} else if (!this.conversationStarted) {
				this.qwenSessionId = crypto.randomUUID();
			}
			this.endQuery(gen);
		}
	}

	/** Stop the running question. Called by the provider on dispose. */
	killProcess(): void {
		this.child?.kill();
	}
}

registerProviderFactory(PROVIDER_NAME, async (config) => new QwenSDKProvider(config as QwenSDKConfig));
