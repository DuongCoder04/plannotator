/**
 * The Qwen Code Ask AI provider against a fake `qwen`
 * (tests/test-fixtures/fake-qwen-cli.ts). No real Qwen Code runs, and
 * QWEN_HOME always points into a temp folder.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeQwenCli, fakeQwenRuns } from "../../../tests/test-fixtures/fake-qwen-cli.ts";
import type { AIMessage, AISession } from "../types.ts";
import { QwenSDKProvider, qwenHomeDir } from "./qwen-sdk.ts";

const tempDirs: string[] = [];
const savedQwenHome = process.env.QWEN_HOME;

afterEach(() => {
	if (savedQwenHome === undefined) delete process.env.QWEN_HOME;
	else process.env.QWEN_HOME = savedQwenHome;
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function setup() {
	const dir = mkdtempSync(join(tmpdir(), "plannotator-qwen-sdk-"));
	tempDirs.push(dir);
	process.env.QWEN_HOME = join(dir, "qwen-home");
	const fake = fakeQwenCli(dir);
	const provider = new QwenSDKProvider({ type: "qwen-sdk", cwd: dir, qwenExecutablePath: fake.bin });
	return { dir, fake, provider };
}

async function newSession(provider: QwenSDKProvider, model?: string): Promise<AISession> {
	return provider.createSession({
		context: { mode: "plan-review", plan: { plan: "# The plan under review" } },
		...(model ? { model } : {}),
	});
}

async function ask(session: AISession, prompt: string): Promise<AIMessage[]> {
	const out: AIMessage[] = [];
	for await (const msg of session.query(prompt)) out.push(msg);
	return out;
}

function pidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

const posix = process.platform !== "win32";

describe("QwenSDKProvider", () => {
	test.if(posix)("the first question starts a read-only qwen session with the context on stdin; the next continues it", async () => {
		const { fake, provider } = setup();
		const session = await newSession(provider, "qwen3-coder-plus");

		const first = await ask(session, "What does step 2 do?");
		expect(first.filter((m) => m.type === "text_delta").map((m) => (m as { delta: string }).delta).join("")).toBe("pong");
		expect(first.at(-1)).toMatchObject({ type: "result", success: true, result: "pong", sessionId: session.id });
		expect(first.some((m) => m.type === "error")).toBe(false);

		const second = await ask(session, "And step 3?");
		expect(second.at(-1)).toMatchObject({ type: "result", success: true });

		const [run1, run2] = fakeQwenRuns(fake.log);
		expect(run1!.args.slice(0, 2)).toEqual(["--session-id", session.id]);
		expect(run2!.args.slice(0, 2)).toEqual(["--resume", session.id]);
		for (const run of [run1!, run2!]) {
			expect(run.args).toContain("--exclude-tools=exit_plan_mode");
			expect(run.args.join(" ")).toContain("--approval-mode plan");
			expect(run.args.join(" ")).toContain("--output-format stream-json --include-partial-messages");
			expect(run.args.join(" ")).toContain("--model qwen3-coder-plus");
		}
		// The review context goes with the first question only, and on stdin.
		expect(run1!.stdin).toContain("# The plan under review");
		expect(run1!.stdin).toContain("What does step 2 do?");
		expect(run1!.args.join(" ")).not.toContain("step 2");
		expect(run2!.stdin).not.toContain("# The plan under review");
		expect(run2!.stdin).toContain("And step 3?");
	});

	test.if(posix)("a run stopped by qwen's wall-time budget reports it with qwen's stderr", async () => {
		const { fake, provider } = setup();
		fake.setMode("wall-time");
		const messages = await ask(await newSession(provider), "Explain");
		expect(messages).toHaveLength(1);
		const error = messages[0] as { type: string; error: string; code: string };
		expect(error.type).toBe("error");
		expect(error.code).toBe("qwen_process_exit");
		expect(error.error).toContain("longer than 10m");
		expect(error.error).toContain("Run exceeded --max-wall-time");
	});

	test.if(posix)("a first question that got no answer is retried as a new qwen session, not a resume", async () => {
		const { fake, provider } = setup();
		const session = await newSession(provider);
		fake.setMode("silent");
		const failed = await ask(session, "First try");
		expect(failed[0]).toMatchObject({ type: "error", code: "qwen_process_exit" });
		expect((failed[0] as { error: string }).error).toContain("exited with code 1");

		fake.setMode("answer");
		const retried = await ask(session, "Second try");
		expect(retried.at(-1)).toMatchObject({ type: "result", success: true });

		const [run1, run2] = fakeQwenRuns(fake.log);
		expect(run1!.args[0]).toBe("--session-id");
		expect(run2!.args[0]).toBe("--session-id");
		expect(run2!.args[1]).not.toBe(run1!.args[1]);
		// The retry still carries the review context: no conversation holds it yet.
		expect(run2!.stdin).toContain("# The plan under review");
	});

	test.if(posix)("abort stops the running qwen and ends the question without an error", async () => {
		const { fake, provider } = setup();
		fake.setMode("hang");
		const session = await newSession(provider);
		const pending = ask(session, "Long question");
		let run = fakeQwenRuns(fake.log)[0];
		for (let i = 0; i < 100 && !run; i++) {
			await Bun.sleep(20);
			run = fakeQwenRuns(fake.log)[0];
		}
		expect(run).toBeDefined();
		session.abort();
		const messages = await pending;
		expect(messages.some((m) => m.type === "error")).toBe(false);
		let alive = pidAlive(run!.pid);
		for (let i = 0; i < 100 && alive; i++) {
			await Bun.sleep(20);
			alive = pidAlive(run!.pid);
		}
		expect(alive).toBe(false);
	});

	test("a qwen that cannot be started is reported, not thrown", async () => {
		const { dir } = setup();
		const provider = new QwenSDKProvider({ type: "qwen-sdk", cwd: dir, qwenExecutablePath: join(dir, "no-such-qwen") });
		const messages = await ask(await newSession(provider), "Hello");
		expect(messages).toHaveLength(1);
		expect(messages[0]).toMatchObject({ type: "error", code: "qwen_process_exit" });
		expect((messages[0] as { error: string }).error).toContain("Qwen Code could not run");
	});

	test("models come from $QWEN_HOME/settings.json (comments allowed) without running qwen", async () => {
		const { dir, fake, provider } = setup();
		const home = process.env.QWEN_HOME!;
		mkdirSync(home, { recursive: true });
		writeFileSync(
			join(home, "settings.json"),
			`{
  // Qwen Code accepts comments here.
  "model": { "name": "qwen3-coder-plus" },
  "modelProviders": {
    "openai": [
      { "id": "qwen3-coder-plus", "name": "Qwen3 Coder Plus" },
      { "id": "gpt-local", "name": "Local model" },
    ],
  },
}`,
		);
		await provider.fetchModels();
		expect(provider.models).toEqual([
			{ id: "qwen3-coder-plus", label: "Qwen3 Coder Plus", default: true },
			{ id: "gpt-local", label: "Local model" },
		]);
		expect(fakeQwenRuns(fake.log)).toHaveLength(0);

		rmSync(join(home, "settings.json"));
		const empty = new QwenSDKProvider({ type: "qwen-sdk", cwd: dir });
		await empty.fetchModels();
		expect(empty.models).toBeUndefined();
	});

	test("qwenHomeDir follows qwen: $QWEN_HOME with ~ expanded and relative paths from cwd, else ~/.qwen", () => {
		const home = join(tmpdir(), "home-x");
		const cwd = join(tmpdir(), "project-y");
		expect(qwenHomeDir({}, home, cwd)).toBe(join(home, ".qwen"));
		expect(qwenHomeDir({ QWEN_HOME: "  " }, home, cwd)).toBe(join(home, ".qwen"));
		expect(qwenHomeDir({ QWEN_HOME: "~/qh" }, home, cwd)).toBe(join(home, "qh"));
		expect(qwenHomeDir({ QWEN_HOME: "rel/qh" }, home, cwd)).toBe(join(cwd, "rel", "qh"));
		expect(qwenHomeDir({ QWEN_HOME: join(tmpdir(), "abs") }, home, cwd)).toBe(join(tmpdir(), "abs"));
	});
});
