/**
 * Plannotator as Qwen Code's trusted sender (inbox-qwen-trust.ts): minted
 * when the connect step connects Qwen Code, revoked when Qwen Code is turned
 * off or Plannotator is uninstalled. A fake `qwen` on a scratch PATH keeps
 * its grants in the scratch Qwen home as Qwen does
 * (tests/helpers/fake-agents.ts); the real qwen is never run and the real
 * ~/.qwen never read.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createFakeAgents, type FakeAgents } from "../../tests/helpers/fake-agents";
import { connectInboxAgents, createAgentEnvironmentFor, formatConnectReport, planInboxAgentRemoval, setInboxAgentReach, type AgentEnvironment } from "./inbox-agents";
import { INBOX_QWEN_TRUST_LABEL, ensureQwenTrust, parseQwenVersion, qwenHasTrust, qwenTrustPath, qwenTrustRemoval, qwenWakeToken, readQwenTrust } from "./inbox-qwen-trust";

const SELF = ["/opt/plannotator/bin/plannotator"];
const OURS = [...SELF, "inbox", "mcp"];

let fake: FakeAgents;
let dataDir: string;
let savedDataDir: string | undefined;

beforeEach(() => {
  fake = createFakeAgents("plannotator-qwen-trust-");
  dataDir = join(fake.root, "data");
  mkdirSync(dataDir, { recursive: true });
  savedDataDir = process.env.PLANNOTATOR_DATA_DIR;
  process.env.PLANNOTATOR_DATA_DIR = dataDir;
});
afterEach(() => {
  process.env.PLANNOTATOR_DATA_DIR = savedDataDir;
  fake.remove();
});

function environment(extra: Record<string, string> = {}): AgentEnvironment {
  return createAgentEnvironmentFor({ platform: "linux", homeDir: fake.home, env: { ...fake.env, ...extra } });
}
const options = (extra: Record<string, string> = {}) => ({ dataDir, selfCommand: SELF, environment: environment(extra) });
const qwenHome = () => join(fake.home, ".qwen");
/** The grants the fake qwen holds, with their tokens. */
const grants = (home = qwenHome()): { id: string; label: string; token: string }[] => {
  try {
    return (JSON.parse(readFileSync(join(home, "peer-controllers.json"), "utf8")) as { controllers: { id: string; label: string; token: string }[] }).controllers;
  } catch {
    return [];
  }
};
const controllerCalls = (sub: string) => fake.calls().filter((call) => call.name === "qwen" && call.args[0] === "sessions" && call.args[2] === sub);

describe("Qwen Code's trusted sender", () => {
  test("only Qwen Code 0.24 or later has trusted senders (nightlies count)", () => {
    expect(qwenHasTrust(parseQwenVersion("0.24.0\n"))).toBe(true);
    expect(qwenHasTrust(parseQwenVersion("0.27.0-nightly.20261020.abc"))).toBe(true);
    expect(qwenHasTrust(parseQwenVersion("0.23.9"))).toBe(false);
    expect(qwenHasTrust(parseQwenVersion("qwen 1.0"))).toBe(false);
  });

  test("connecting Qwen Code mints one token, kept 0600 for this Qwen home, said in the band and the terminal; the next run keeps it", async () => {
    fake.install("qwen");
    const report = await connectInboxAgents(options());
    expect(report.added).toEqual(["qwen"]);
    expect(report.trusted).toEqual(["qwen"]);
    expect(controllerCalls("add").map((call) => call.args)).toEqual([["sessions", "controllers", "add", "--label", INBOX_QWEN_TRUST_LABEL, "--json"]]);
    const [grant] = grants();
    const file = readQwenTrust(dataDir)!;
    expect(file).toMatchObject({ home: qwenHome(), id: grant!.id, token: grant!.token });
    expect(statSync(qwenTrustPath(dataDir)).mode & 0o777).toBe(0o600);
    expect(qwenWakeToken(dataDir, qwenHome())).toBe(grant!.token);
    // Never presented to another Qwen home.
    expect(qwenWakeToken(dataDir, join(fake.root, "other-qwen"))).toBeNull();
    expect(formatConnectReport(report).join("\n")).toContain("trusted sender");

    const again = await connectInboxAgents(options());
    expect(again.trusted ?? []).toEqual([]);
    expect(controllerCalls("add")).toHaveLength(1);
    expect(grants()).toHaveLength(1);
    expect(readQwenTrust(dataDir)!.token).toBe(grant!.token);
  });

  test("Qwen Code before 0.24: connected, no token, nothing minted", async () => {
    fake.install("qwen");
    const report = await connectInboxAgents(options({ FAKE_QWEN_VERSION: "0.23.0" }));
    expect(report.added).toEqual(["qwen"]);
    expect(report.trusted ?? []).toEqual([]);
    expect(controllerCalls("add")).toEqual([]);
    expect(existsSync(qwenTrustPath(dataDir))).toBe(false);
  });

  test("a grant the person revoked in Qwen is never minted again by itself; turning Qwen Code off and on in Settings mints a new one", async () => {
    fake.install("qwen");
    await connectInboxAgents(options());
    // The person runs `qwen sessions controllers remove <id>`.
    writeFileSync(join(qwenHome(), "peer-controllers.json"), JSON.stringify({ schemaVersion: 1, controllers: [] }));
    await connectInboxAgents(options());
    expect(controllerCalls("add")).toHaveLength(1);
    expect(readQwenTrust(dataDir)).toMatchObject({ revoked_outside_at: expect.any(String) });
    expect(qwenWakeToken(dataDir, qwenHome())).toBeNull();
    await connectInboxAgents(options());
    expect(controllerCalls("add")).toHaveLength(1);

    expect(await setInboxAgentReach("qwen", false, options())).toBeNull();
    expect(await setInboxAgentReach("qwen", true, options())).toBeNull();
    expect(controllerCalls("add")).toHaveLength(2);
    expect(qwenWakeToken(dataDir, qwenHome())).toBe(grants()[0]!.token);
  });

  test("turning Qwen Code off in Settings revokes the token in Qwen and forgets it", async () => {
    fake.install("qwen");
    await connectInboxAgents(options());
    const { id } = readQwenTrust(dataDir)!;
    expect(await setInboxAgentReach("qwen", false, options())).toBeNull();
    expect(controllerCalls("remove").map((call) => call.args)).toEqual([["sessions", "controllers", "remove", id!]]);
    expect(grants()).toEqual([]);
    expect(existsSync(qwenTrustPath(dataDir))).toBe(false);
    // Off stays off: the next run neither connects nor mints.
    await connectInboxAgents(options());
    expect(controllerCalls("add")).toHaveLength(1);
  });

  test("a token that cannot be revoked keeps Qwen Code on, and says why", async () => {
    fake.install("qwen");
    await connectInboxAgents(options());
    const problem = await setInboxAgentReach("qwen", false, options({ FAKE_QWEN_CONTROLLERS_FAIL: "1" }));
    expect(problem).toContain("qwen sessions controllers remove");
    expect(grants()).toHaveLength(1);
    expect(readQwenTrust(dataDir)!.token).toBe(grants()[0]!.token);
  });

  test("uninstall revokes it (also when Plannotator only found Qwen's entry); with no qwen on PATH it names the command", async () => {
    fake.install("qwen");
    await connectInboxAgents(options());
    const removal = qwenTrustRemoval(dataDir, environment())!;
    expect(removal.describe).toBe(`Plannotator's trusted-sender token in Qwen Code (qwen sessions controllers remove ${readQwenTrust(dataDir)!.id})`);
    expect(removal.manual).toBeNull();
    // Not in the MCP removal plan: the token is its own item, never mistaken for the entry.
    expect(planInboxAgentRemoval(dataDir, environment(), OURS).items.map((item) => item.describe)).toEqual(["MCP server plannotator-inbox from Qwen Code (qwen mcp remove -s user plannotator-inbox)"]);

    const noQwen = createAgentEnvironmentFor({ platform: "linux", homeDir: fake.home, env: { ...fake.env, PATH: join(fake.root, "empty") } });
    const manual = qwenTrustRemoval(dataDir, noQwen)!;
    expect(manual.manual).toBe(`qwen sessions controllers remove ${readQwenTrust(dataDir)!.id}`);
    expect(await manual.apply()).toContain("run `qwen sessions controllers remove");
    expect(grants()).toHaveLength(1);

    expect(await removal.apply()).toBeNull();
    expect(grants()).toEqual([]);
    expect(existsSync(qwenTrustPath(dataDir))).toBe(false);
    expect(qwenTrustRemoval(dataDir, environment())).toBeNull();
  });

  test("a grant with Plannotator's label that the data dir lost is revoked before a new one is minted: Qwen never keeps an orphan", async () => {
    fake.install("qwen");
    await connectInboxAgents(options());
    const orphan = grants()[0]!.id;
    writeFileSync(qwenTrustPath(dataDir), "{ broken");
    expect((await ensureQwenTrust(dataDir, environment())).kind).toBe("added");
    expect(controllerCalls("remove").map((call) => call.args[3])).toEqual([orphan]);
    expect(grants()).toHaveLength(1);
    expect(grants()[0]!.id).not.toBe(orphan);
    expect(readQwenTrust(dataDir)!.token).toBe(grants()[0]!.token);
  });

  test("a failing mint leaves no token and no grant, is tried again next run, and is said once", async () => {
    fake.install("qwen");
    const first = await connectInboxAgents(options({ FAKE_QWEN_CONTROLLERS_FAIL: "1" }));
    expect(first.added).toEqual(["qwen"]);
    expect(first.trust_failed?.[0]?.reason).toContain("qwen sessions controllers");
    expect(qwenWakeToken(dataDir, qwenHome())).toBeNull();
    const second = await connectInboxAgents(options({ FAKE_QWEN_CONTROLLERS_FAIL: "1" }));
    expect(second.trust_failed ?? []).toEqual([]);
    const fixed = await connectInboxAgents(options());
    expect(fixed.trusted).toEqual(["qwen"]);
    expect(qwenWakeToken(dataDir, qwenHome())).toBe(grants()[0]!.token);
  });

  test("PLANNOTATOR_INBOX_CONNECT=0 mints nothing", async () => {
    fake.install("qwen");
    await connectInboxAgents(options({ PLANNOTATOR_INBOX_CONNECT: "0" }));
    expect(controllerCalls("add")).toEqual([]);
    expect(existsSync(qwenTrustPath(dataDir))).toBe(false);
  });
});
