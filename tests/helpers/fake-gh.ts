/**
 * A fake `gh` for tests of which signed-in account a GitHub PR review runs as
 * (#2157). `makeFakeGh` writes a `gh` into a scratch bin folder (a sh wrapper
 * that runs this file with bun); put that folder first on PATH. The real gh,
 * the real ~/.config/gh and the network are never touched.
 *
 * The fake knows a few accounts on one host. It acts as the account whose
 * token is in GH_TOKEN / GH_ENTERPRISE_TOKEN, else as the active one, and
 * answers only what that account may read. Every call is logged (args and
 * the account it acted as, never a token) to `log`.
 */
import { appendFileSync, chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface FakeGhAccount {
  login: string;
  token: string;
  active?: boolean;
  /** `success` by default; anything else is a broken login gh can't use. */
  state?: string;
  tokenSource?: string;
}

export interface FakeGhScenario {
  host?: string;
  accounts: FakeGhAccount[];
  /** `owner/repo` → the logins that can read it, and its PR numbers. */
  repos: Record<string, { readers: string[]; prs: number[] }>;
  /** false: answer `--json` like a gh older than 2.70 (unknown flag). Default true. */
  jsonStatus?: boolean;
  /** true: `gh auth token --user` is refused (an old gh without --user). */
  noTokenUser?: boolean;
  /** true: every `gh api` call fails as if offline. */
  offline?: boolean;
}

export interface FakeGhCall {
  args: string[];
  as: string | null;
}

export interface FakeGh {
  binDir: string;
  /** Env to spawn with: PATH (fake first), a scratch HOME and gh config dir. */
  env: Record<string, string>;
  calls(): FakeGhCall[];
  cleanup(): void;
}

export const FAKE_PATCH = "diff --git a/src/app.ts b/src/app.ts\n--- a/src/app.ts\n+++ b/src/app.ts\n@@ -1 +1 @@\n-old\n+new\n";

export function makeFakeGh(scenario: FakeGhScenario): FakeGh {
  const root = mkdtempSync(join(tmpdir(), "plannotator-fake-gh-"));
  const binDir = join(root, "bin");
  const home = join(root, "home");
  mkdirSync(binDir);
  mkdirSync(home);
  const scenarioFile = join(root, "scenario.json");
  const log = join(root, "calls.jsonl");
  writeFileSync(scenarioFile, JSON.stringify(scenario));
  writeFileSync(log, "");
  const gh = join(binDir, "gh");
  writeFileSync(gh, `#!/bin/sh\nexec '${process.execPath}' '${import.meta.path}' "$@"\n`);
  chmodSync(gh, 0o755);
  return {
    binDir,
    env: {
      PATH: `${binDir}:/usr/bin:/bin`,
      HOME: home,
      GH_CONFIG_DIR: join(home, "gh-config"),
      XDG_CONFIG_HOME: join(home, "config"),
      GH_PROMPT_DISABLED: "1",
      GH_NO_UPDATE_NOTIFIER: "1",
      FAKE_GH_SCENARIO: scenarioFile,
      FAKE_GH_LOG: log,
    },
    calls: () =>
      readFileSync(log, "utf-8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as FakeGhCall),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

/**
 * Run a PR runtime (`bun`: packages/server/pr.ts, `pi`: the Pi extension's)
 * in a child process whose env is only the fake's (PATH with the fake gh
 * first, scratch HOME and gh config dir): it checks auth for acme/widgets#7,
 * then reads the user and fetches the PR. Two accounts: tobey (active) and
 * tobey-work; `readers` says which can read the repo.
 */
export async function probeGhAccountRuntime(
  which: "bun" | "pi",
  readers: string[],
): Promise<{ fake: FakeGh; out: Record<string, unknown> }> {
  const fake = makeFakeGh({
    accounts: [{ login: "tobey", token: "gho_personal01", active: true }, { login: "tobey-work", token: "gho_work02" }],
    repos: { "acme/widgets": { readers, prs: [7] } },
  });
  const probe = join(import.meta.dir, "gh-account-runtime-probe.ts");
  const proc = Bun.spawn([process.execPath, probe, which, "acme/widgets", "7"], {
    env: { ...fake.env, NO_BROWSER: "/usr/bin/true" },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  if (code !== 0) {
    fake.cleanup();
    throw new Error(`probe exited ${code}: ${stderr}`);
  }
  return { fake, out: JSON.parse(stdout.trim().split("\n").at(-1)!) as Record<string, unknown> };
}

// --- The fake itself, when run as `gh` ---

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

function runFake(args: string[]): number {
  const scenario = JSON.parse(readFileSync(process.env.FAKE_GH_SCENARIO!, "utf-8")) as FakeGhScenario;
  const host = scenario.host ?? "github.com";
  const envVar = host === "github.com" || host.endsWith(".ghe.com") ? "GH_TOKEN" : "GH_ENTERPRISE_TOKEN";
  const envToken = process.env[envVar];
  const active = scenario.accounts.find((a) => a.active) ?? null;
  const me = envToken ? scenario.accounts.find((a) => a.token === envToken) ?? null : active;
  appendFileSync(process.env.FAKE_GH_LOG!, `${JSON.stringify({ args, as: me?.login ?? null })}\n`);
  const out = (s: string) => process.stdout.write(s.endsWith("\n") ? s : `${s}\n`);
  const err = (s: string, code = 1) => {
    process.stderr.write(`${s}\n`);
    return code;
  };
  if (envToken && !me) return err("gh: Bad credentials (HTTP 401)");

  const [cmd, sub] = args;
  if (cmd === "auth" && sub === "status") {
    if (args.includes("--json")) {
      if (scenario.jsonStatus === false) return err('unknown flag: --json\n\nUsage:  gh auth status [flags]');
      const entries = scenario.accounts.map((a) => ({
        state: a.state ?? "success",
        active: !!a.active,
        host,
        login: a.login,
        tokenSource: a.tokenSource ?? "keyring",
        token: "gho_************************************",
        scopes: "repo, read:org",
        gitProtocol: "https",
      }));
      out(JSON.stringify({ hosts: { [host]: entries } }));
      return 0;
    }
    const lines = [host];
    for (const a of scenario.accounts) {
      const ok = (a.state ?? "success") === "success";
      lines.push(
        ok
          ? `  ✓ Logged in to ${host} account ${a.login} (${a.tokenSource ?? "keyring"})`
          : `  X Failed to log in to ${host} account ${a.login} (${a.tokenSource ?? "keyring"})`,
        `  - Active account: ${a.active ? "true" : "false"}`,
        "  - Git operations protocol: https",
        "  - Token: gho_************************************",
        "",
      );
    }
    out(lines.join("\n"));
    return 0;
  }
  if (cmd === "auth" && sub === "token") {
    const user = flag(args, "--user") ?? flag(args, "-u");
    if (user && scenario.noTokenUser) return err("unknown flag: --user");
    const account = user ? scenario.accounts.find((a) => a.login === user) : me;
    if (!account) return err(`no account found for ${user}`);
    out(account.token);
    return 0;
  }
  if (cmd === "auth") return err(`fake gh: unexpected auth ${sub}`);

  const readable = (repo: string) => !!me && (scenario.repos[repo]?.readers.includes(me.login) ?? false);
  if (cmd === "api") {
    if (scenario.offline) return err("error connecting to api.github.com\ncheck your internet connection or https://githubstatus.com");
    const endpoint = sub ?? "";
    if (endpoint === "user") {
      out(me?.login ?? "");
      return 0;
    }
    let m = /^repos\/([^/]+\/[^/]+)\/pulls\/(\d+)$/.exec(endpoint);
    if (m) {
      if (!readable(m[1]) || !scenario.repos[m[1]].prs.includes(Number(m[2]))) return err("gh: Not Found (HTTP 404)");
      out(m[2]);
      return 0;
    }
    m = /^repos\/([^/]+\/[^/]+)$/.exec(endpoint);
    if (m) {
      if (!readable(m[1])) return err("gh: Not Found (HTTP 404)");
      out(m[1]);
      return 0;
    }
    m = /^repos\/([^/]+\/[^/]+)\/compare\//.exec(endpoint);
    if (m && readable(m[1])) {
      out("c".repeat(40));
      return 0;
    }
    return err("gh: Not Found (HTTP 404)");
  }
  const repo = flag(args, "--repo") ?? (cmd === "repo" ? sub : undefined);
  if (repo && !readable(repo)) return err(`GraphQL: Could not resolve to a Repository with the name '${repo}'. (repository)`);
  if (cmd === "pr" && sub === "diff") {
    process.stdout.write(FAKE_PATCH);
    return 0;
  }
  if (cmd === "pr" && sub === "view") {
    const number = Number(args[2]);
    out(JSON.stringify({
      id: "PR_fake",
      title: "Fake PR",
      author: { login: "someone" },
      baseRefName: "main",
      headRefName: "feature",
      baseRefOid: "a".repeat(40),
      headRefOid: "b".repeat(40),
      url: `https://${host}/${repo}/pull/${number}`,
      changedFiles: 1,
    }));
    return 0;
  }
  if (cmd === "repo" && sub === "view") {
    out("main");
    return 0;
  }
  return err(`fake gh: unsupported ${args.join(" ")}`);
}

if (import.meta.main) process.exit(runFake(process.argv.slice(2)));
