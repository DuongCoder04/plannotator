/**
 * Safe updates, step 1: `update-prepare` (the running Plannotator downloads
 * the install script and both binaries' checksums with its own fetch) and the
 * POSIX update wrapper that runs it, then runs the saved script with
 * PLANNOTATOR_EXPECTED_SHA256.
 *
 * The rule these guard: an update either installs the genuine release or
 * changes nothing, and never leaves the install stuck. Offline, a refusing
 * proxy, a bad `.sha256`, Ctrl-C and a kill all end with the old binary in
 * place, the lock released and a result recorded.
 *
 * Everything is loopback or a stub: a fake release server, a stub `curl` for
 * install.sh's own binary download, a temp HOME and TMPDIR. Nothing reaches
 * the network and nothing downloaded is a real binary.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { autoUpdatePaths, installerCommand } from "./auto-update";
import {
  UPDATE_CHECKSUM_MISMATCH,
  UPDATE_PREPARE_FAILED,
  candidateAssets,
  normalizeReleaseTag,
  prepareUpdate,
  releaseDownloadUrl,
  runUpdatePrepareCommand,
  sweepStaleUpdateDirs,
} from "./update-prepare";

const SCRIPT_HEAD = '#!/bin/bash\nREPO="backnotprop/plannotator"\n';
const OS = process.platform === "darwin" ? "darwin" : "linux";
const ARM = "a".repeat(64);
const X64 = "b".repeat(64);

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "plannotator-prep-test-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const staged = (dir: string = root) => readdirSync(dir).filter((n) => n.startsWith("plannotator-update-"));

type Route = (path: string) => Response | Promise<Response>;
/** A fetch over a route table, as the release server would answer. */
function fakeFetch(route: Route): typeof fetch {
  return (async (input: RequestInfo | URL) => route(new URL(String(input)).pathname)) as typeof fetch;
}
const genuine: Route = (path) => {
  if (path === "/install.sh") return new Response(`${SCRIPT_HEAD}echo ok\n# PLANNOTATOR_EXPECTED_SHA256\n`);
  const m = /\/v1\.2\.3\/(plannotator-[a-z]+-(arm64|x64))\.sha256$/.exec(path);
  if (m) return new Response(`${m[2] === "arm64" ? ARM : X64.toUpperCase()}  ${m[1]}\n`);
  return new Response("not found", { status: 404 });
};
const ENV = { PLANNOTATOR_INSTALL_SCRIPT_URL: "http://127.0.0.1:9/install.sh", PLANNOTATOR_RELEASE_DOWNLOAD_URL: "http://127.0.0.1:9/dl" };
const prepare = (route: Route, version = "1.2.3", platform: NodeJS.Platform = "linux") =>
  prepareUpdate({ version, platform, env: ENV, tmpRoot: root, fetchImpl: fakeFetch(route) });

describe("prepareUpdate", () => {
  test("stages the script and both CPU types' checksums in a private dir", async () => {
    const r = await prepare(genuine);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(readFileSync(join(r.dir, "expected-sha256"), "utf-8")).toBe(`plannotator-linux-arm64=${ARM} plannotator-linux-x64=${X64}`);
    expect(readFileSync(join(r.dir, "install.sh"), "utf-8")).toStartWith(SCRIPT_HEAD);
    expect(statSync(r.dir).mode & 0o777).toBe(0o700);
    expect(statSync(join(r.dir, "install.sh")).mode & 0o777).toBe(0o600);
    expect(statSync(join(r.dir, "expected-sha256")).mode & 0o777).toBe(0o600);
    expect(r.scriptChecksPin).toBe(true);
  });

  test("a version with or without the v reaches the same tag; anything else is refused", async () => {
    expect((await prepare(genuine, "v1.2.3")).ok).toBe(true);
    expect(normalizeReleaseTag("01.2.3")).toBe("v1.2.3");
    for (const bad of ["1.2.3-rc.1", "1.2", "latest", "1.2.3; rm -rf /", "../1.2.3"]) {
      expect(normalizeReleaseTag(bad)).toBeNull();
      expect(await prepare(genuine, bad)).toMatchObject({ ok: false });
    }
  });

  test("the install script picks the CPU type itself, so both are pinned; macOS asks for the darwin pair", () => {
    expect(candidateAssets("darwin")).toEqual(["plannotator-darwin-arm64", "plannotator-darwin-x64"]);
    expect(candidateAssets("linux")).toEqual(["plannotator-linux-arm64", "plannotator-linux-x64"]);
  });

  // Never stuck: each of these is "couldn't download", nothing is staged, and the caller retries later.
  const failures: Array<[string, Route]> = [
    ["offline", () => Promise.reject(new TypeError("Unable to connect. Is the computer able to access the url?"))],
    ["a refusing proxy, as Bun 1.3.14 reports it (a 502 response)", () => new Response("Bad Gateway", { status: 502 })],
    ["a refusing proxy, as Bun 1.4.4 reports it (a thrown error)", () => Promise.reject(new Error("ConnectionRefused"))],
    ["a missing .sha256", (p) => (p.endsWith(".sha256") ? new Response("", { status: 404 }) : genuine(p))],
    ["a .sha256 that is a web page", (p) => (p.endsWith(".sha256") ? new Response("<html>sign in to the wifi</html>") : genuine(p))],
    ["a short .sha256", (p) => (p.endsWith(".sha256") ? new Response("abc123  plannotator\n") : genuine(p))],
    ["only one CPU type's .sha256", (p) => (p.endsWith("x64.sha256") ? new Response("", { status: 404 }) : genuine(p))],
    ["a captive portal instead of the script", (p) => (p === "/install.sh" ? new Response("<html>login</html>") : genuine(p))],
    ["a script that is not Plannotator's", (p) => (p === "/install.sh" ? new Response("#!/bin/bash\necho hi\n") : genuine(p))],
    ["an oversized script", (p) => (p === "/install.sh" ? new Response(SCRIPT_HEAD + "#".repeat(5 * 1024 * 1024)) : genuine(p))],
  ];
  for (const [name, route] of failures) {
    test(`${name}: fails, stages nothing`, async () => {
      const r = await prepare(route);
      expect(r.ok).toBe(false);
      expect(staged()).toEqual([]);
    });
  }

  test("a stalled server times out instead of hanging the update", async () => {
    const hang: typeof fetch = ((_: unknown, init?: RequestInit) =>
      new Promise((_r, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("timed out"))))) as typeof fetch;
    const r = await prepareUpdate({ version: "1.2.3", platform: "linux", env: ENV, tmpRoot: root, fetchImpl: hang, timeoutMs: 50 });
    expect(r).toMatchObject({ ok: false });
  });

  test("the download base can only move to https or loopback", () => {
    expect(releaseDownloadUrl({ PLANNOTATOR_RELEASE_DOWNLOAD_URL: "http://127.0.0.1:5/dl/" })).toBe("http://127.0.0.1:5/dl");
    expect(releaseDownloadUrl({ PLANNOTATOR_RELEASE_DOWNLOAD_URL: "https://mirror.example/dl" })).toBe("https://mirror.example/dl");
    for (const bad of ["http://evil.example/dl", "file:///tmp/dl", "https://u:p@mirror.example/dl"]) {
      expect(releaseDownloadUrl({ PLANNOTATOR_RELEASE_DOWNLOAD_URL: bad })).toBe("https://github.com/backnotprop/plannotator/releases/download");
    }
  });

  test("Windows never comes here (its wrapper is unchanged)", async () => {
    expect(await prepare(genuine, "1.2.3", "win32")).toMatchObject({ ok: false });
  });
});

describe("update-prepare command", () => {
  test("prints only the staged dir on stdout", async () => {
    let out = "";
    let err = "";
    const code = await runUpdatePrepareCommand(["1.2.3"], {
      platform: "linux",
      env: ENV,
      tmpRoot: root,
      fetchImpl: fakeFetch(genuine),
      out: (t) => (out += t),
      err: (t) => (err += t),
    });
    expect(code).toBe(0);
    expect(out).toBe(`${join(root, staged()[0]!)}\n`);
    expect(err).toBe("");
  });

  test("a failure exits 75 with the reason on stderr and nothing on stdout", async () => {
    let out = "";
    let err = "";
    const code = await runUpdatePrepareCommand(["1.2.3"], {
      platform: "linux",
      env: ENV,
      tmpRoot: root,
      fetchImpl: fakeFetch(() => Promise.reject(new Error("offline"))),
      out: (t) => (out += t),
      err: (t) => (err += t),
    });
    expect(code).toBe(UPDATE_PREPARE_FAILED);
    expect(out).toBe("");
    expect(err).toContain("could not download the update");
    expect(err).toContain("nothing was changed");
  });

  test("an older install script (no pin check) still runs, with a note in the log", async () => {
    let err = "";
    const old: Route = (p) => (p === "/install.sh" ? new Response(`${SCRIPT_HEAD}echo old\n`) : genuine(p));
    const code = await runUpdatePrepareCommand(["1.2.3"], { platform: "linux", env: ENV, tmpRoot: root, fetchImpl: fakeFetch(old), out: () => {}, err: (t) => (err += t) });
    expect(code).toBe(0);
    expect(err).toContain("does not check the pinned checksum yet");
  });

  test("leftovers of a killed run are swept once as old as a stale lock, never a live run's", () => {
    const old = join(root, "plannotator-update-old");
    const fresh = join(root, "plannotator-update-fresh");
    const other = join(root, "something-else");
    for (const d of [old, fresh, other]) mkdirSync(d);
    const hourAgo = (Date.now() - 2 * 60 * 60 * 1000) / 1000;
    utimesSync(old, hourAgo, hourAgo);
    utimesSync(other, hourAgo, hourAgo);
    expect(sweepStaleUpdateDirs(root)).toBe(1);
    expect(existsSync(old)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
    expect(existsSync(other)).toBe(true);
  });
});

// ─────────────── The POSIX wrapper, end to end ───────────────

const ENTRY = resolve(import.meta.dir, "update-prepare-entry.ts");
const INSTALL_SH = resolve(import.meta.dir, "../../scripts/install.sh");

interface Release {
  /** The install script served at /install.sh. */
  script: string;
  /** The .sha256 body per asset name; absent = 404. */
  sums: Record<string, string>;
}

function serve(release: Release) {
  const hits: string[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req) {
      const path = new URL(req.url).pathname;
      hits.push(path);
      if (path === "/install.sh") return new Response(release.script);
      const m = /^\/dl\/v\d+\.\d+\.\d+\/(.+)\.sha256$/.exec(path);
      if (m && release.sums[m[1]!] !== undefined) return new Response(release.sums[m[1]!]);
      return new Response("not found", { status: 404 });
    },
  });
  return { server, hits };
}

/**
 * A sandbox for one wrapper run: HOME, TMPDIR, a data dir, and stub-bin with
 * a `curl` that serves the binary install.sh downloads (and logs every call,
 * so a test can prove the wrapper itself never used curl), plus a `git` that
 * fails so the skills checkout never reaches the network.
 */
function sandbox(binaryServed: string) {
  const home = join(root, "home");
  const tmp = join(root, "tmp");
  const data = join(root, "data");
  const stub = join(root, "stub-bin");
  for (const d of [home, tmp, data, stub]) mkdirSync(d, { recursive: true });
  const binarySource = join(root, "served-binary");
  writeFileSync(binarySource, binaryServed);
  const curlLog = join(root, "curl.log");
  writeFileSync(
    join(stub, "curl"),
    `#!/bin/bash
printf '%s\\n' "$*" >> "${curlLog}"
out=""; url=""; prev=""
for a in "$@"; do
  if [ "$prev" = "-o" ]; then out="$a"; fi
  case "$a" in http*) url="$a" ;; esac
  prev="$a"
done
case "$url" in
  *.sha256) printf '%s  plannotator\\n' "$(shasum -a 256 "${binarySource}" 2>/dev/null | cut -d' ' -f1 || sha256sum "${binarySource}" | cut -d' ' -f1)" ;;
  */releases/download/*) cat "${binarySource}" > "$out" ;;
  *) exit 22 ;;
esac
`,
    { mode: 0o755 },
  );
  writeFileSync(join(stub, "git"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  writeFileSync(join(stub, "gh"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  const installed = join(home, ".local", "bin", "plannotator");
  mkdirSync(join(home, ".local", "bin"), { recursive: true });
  writeFileSync(installed, "#!/bin/sh\necho plannotator-old\n", { mode: 0o755 });
  return { home, tmp, data, stub, installed, curlLog };
}

type Box = ReturnType<typeof sandbox>;

function wrapperEnv(box: Box, port: number, extra: Record<string, string> = {}) {
  const paths = autoUpdatePaths(box.data);
  return {
    paths,
    env: {
      PATH: `${box.stub}:/usr/bin:/bin`,
      HOME: box.home,
      TMPDIR: box.tmp,
      PLANNOTATOR_DATA_DIR: box.data,
      PLANNOTATOR_UPDATE_CHECK: "0",
      PLANNOTATOR_SKIP_SEM_INSTALL: "1",
      PLANNOTATOR_SKIP_AGENT_TERMINAL_INSTALL: "1",
      PLANNOTATOR_UPDATE_VERSION: "v1.2.3",
      PLANNOTATOR_UPDATE_RESULT: paths.result,
      PLANNOTATOR_UPDATE_LOCK: paths.lock,
      PLANNOTATOR_UPDATE_BINARY: process.execPath,
      PLANNOTATOR_UPDATE_ENTRY: ENTRY,
      PLANNOTATOR_INSTALL_SCRIPT_URL: `http://127.0.0.1:${port}/install.sh`,
      PLANNOTATOR_RELEASE_DOWNLOAD_URL: `http://127.0.0.1:${port}/dl`,
      ...extra,
    },
  };
}

async function runWrapper(box: Box, port: number, extra: Record<string, string> = {}) {
  const { paths, env } = wrapperEnv(box, port, extra);
  writeFileSync(paths.lock, "1");
  const { file, args } = installerCommand("linux", ["skip-skills"]);
  const proc = Bun.spawn([file, ...args], { env, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  const result = existsSync(paths.result) ? (JSON.parse(readFileSync(paths.result, "utf-8")) as { version: string; exitCode: number }) : null;
  return { out: stdout + stderr, exitCode, result, lockHeld: existsSync(paths.lock) };
}

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const pins = (arm: string, x64: string) => ({ [`plannotator-${OS}-arm64`]: `${arm}  x\n`, [`plannotator-${OS}-x64`]: `${x64}  x\n` });

describe.skipIf(process.platform === "win32")("POSIX update wrapper (safe updates)", () => {
  test("never-stuck: offline, nothing runs; 75 recorded, lock released, nothing staged, binary untouched", async () => {
    const box = sandbox("new");
    const { server } = serve({ script: "", sums: {} });
    const port = server.port;
    server.stop(true);
    const r = await runWrapper(box, port!);
    expect(r.result).toEqual({ version: "v1.2.3", exitCode: UPDATE_PREPARE_FAILED });
    expect(r.lockHeld).toBe(false);
    expect(staged(box.tmp)).toEqual([]);
    expect(readFileSync(box.installed, "utf-8")).toContain("plannotator-old");
    expect(existsSync(box.curlLog)).toBe(false);
  }, 30_000);

  test("never-stuck: a proxy that refuses every connection is a failed download, not a hang", async () => {
    const box = sandbox("new");
    const closed = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("") });
    const proxyPort = closed.port!;
    closed.stop(true);
    const r = await runWrapper(box, 9, {
      // .invalid never resolves, so even a Bun that ignored the proxy reaches nothing.
      PLANNOTATOR_INSTALL_SCRIPT_URL: "https://plannotator.invalid/install.sh",
      PLANNOTATOR_RELEASE_DOWNLOAD_URL: "https://plannotator.invalid/dl",
      HTTPS_PROXY: `http://127.0.0.1:${proxyPort}`,
      https_proxy: `http://127.0.0.1:${proxyPort}`,
    });
    expect(r.result?.exitCode).toBe(UPDATE_PREPARE_FAILED);
    expect(r.lockHeld).toBe(false);
    expect(readFileSync(box.installed, "utf-8")).toContain("plannotator-old");
  }, 60_000);

  test("never-stuck: a bad .sha256 means the script never runs", async () => {
    const box = sandbox("new");
    const marker = join(box.home, "script-ran");
    const { server } = serve({ script: `${SCRIPT_HEAD}touch "${marker}"\n`, sums: pins("not-a-checksum", X64) });
    try {
      const r = await runWrapper(box, server.port!);
      expect(r.result?.exitCode).toBe(UPDATE_PREPARE_FAILED);
      expect(existsSync(marker)).toBe(false);
      expect(r.lockHeld).toBe(false);
      expect(staged(box.tmp)).toEqual([]);
    } finally {
      server.stop(true);
    }
  }, 30_000);

  test("tamper, through the real install.sh: the network swaps the binary and its .sha256; exit 3, old binary kept", async () => {
    // The attacker controls install.sh's own curl (the stub serves an altered
    // binary with a matching .sha256), but not Plannotator's fetch, which got
    // the genuine checksums.
    const box = sandbox("#!/bin/sh\necho evil\n");
    const genuineSha = sha("#!/bin/sh\necho genuine\n");
    const { server, hits } = serve({ script: readFileSync(INSTALL_SH, "utf-8"), sums: pins(genuineSha, genuineSha) });
    try {
      const r = await runWrapper(box, server.port!);
      expect(r.result).toEqual({ version: "v1.2.3", exitCode: UPDATE_CHECKSUM_MISMATCH });
      expect(r.out).toContain("Stopped: the v1.2.3 download doesn't match the checksum Plannotator fetched for it.");
      expect(readFileSync(box.installed, "utf-8")).toContain("plannotator-old");
      expect(r.lockHeld).toBe(false);
      expect(staged(box.tmp)).toEqual([]);
      // The script came from Plannotator's fetch, not curl.
      expect(hits).toContain("/install.sh");
      expect(readFileSync(box.curlLog, "utf-8")).not.toContain("install.sh");
    } finally {
      server.stop(true);
    }
  }, 60_000);

  test("the genuine release, through the real install.sh: installed, checksum confirmed, the staged copy removed", async () => {
    const binary = "#!/bin/sh\necho plannotator-new\n";
    const box = sandbox(binary);
    const { server } = serve({ script: readFileSync(INSTALL_SH, "utf-8"), sums: pins(sha(binary), sha(binary)) });
    try {
      const r = await runWrapper(box, server.port!);
      expect(r.out).toContain("Checksum matches the one Plannotator fetched for v1.2.3.");
      expect(readFileSync(box.installed, "utf-8")).toBe(binary);
      expect(r.result).toEqual({ version: "v1.2.3", exitCode: 0 });
      expect(r.lockHeld).toBe(false);
      expect(staged(box.tmp)).toEqual([]);
      // install.sh did not fetch the .sha256 again over its own connection.
      expect(readFileSync(box.curlLog, "utf-8")).not.toContain(".sha256");
    } finally {
      server.stop(true);
    }
  }, 120_000);

  test("compatibility: an older install.sh (no pin check) runs exactly as before and its exit code is recorded", async () => {
    const box = sandbox("new");
    const argsFile = join(box.home, "args");
    const { server } = serve({ script: `${SCRIPT_HEAD}printf '%s\\n' "$@" > "${argsFile}"\nexit 7\n`, sums: pins(ARM, X64) });
    try {
      const r = await runWrapper(box, server.port!);
      expect(readFileSync(argsFile, "utf-8").trim().split("\n")).toEqual(["--version", "v1.2.3", "--non-interactive", "--skip-skills"]);
      expect(r.result).toEqual({ version: "v1.2.3", exitCode: 7 });
      expect(r.out).toContain("does not check the pinned checksum yet");
      expect(r.lockHeld).toBe(false);
    } finally {
      server.stop(true);
    }
  }, 30_000);

  test("Ctrl-C mid-install: 130 recorded, lock released, the staged copy removed", async () => {
    const box = sandbox("new");
    const { server } = serve({ script: `${SCRIPT_HEAD}echo "fake installer started"\nsleep 30\n`, sums: pins(ARM, X64) });
    try {
      const { paths, env } = wrapperEnv(box, server.port!);
      writeFileSync(paths.lock, "1");
      const { file, args } = installerCommand("linux", []);
      const child = spawn(file, args, { detached: true, stdio: ["ignore", "pipe", "pipe"], env });
      let out = "";
      child.stdout!.on("data", (c) => (out += c));
      const exited = new Promise<number | null>((r) => child.on("close", (code) => r(code)));
      const deadline = Date.now() + 20_000;
      while (!out.includes("fake installer started") && Date.now() < deadline) await Bun.sleep(20);
      expect(staged(box.tmp)).toHaveLength(1);
      process.kill(-child.pid!, "SIGINT");
      expect(await exited).toBe(130);
      expect(existsSync(paths.lock)).toBe(false);
      expect(JSON.parse(readFileSync(paths.result, "utf-8"))).toEqual({ version: "v1.2.3", exitCode: 130 });
      expect(staged(box.tmp)).toEqual([]);
    } finally {
      server.stop(true);
    }
  }, 30_000);

  // The wrapper removes the dir `update-prepare` printed: it must only ever
  // remove a plannotator-update-* path, whatever that output is.
  for (const [name, printed] of [
    ["the temp root itself", "$TMPDIR"],
    ["a dir below one named plannotator-update-*", "$TMPDIR/plannotator-update-x/inner"],
    ["a path without the prefix", "$HOME"],
    ["two lines", "$TMPDIR/plannotator-update-x\n$HOME"],
    ["a relative path", "plannotator-update-x"],
  ] as const) {
    test(`a prepare step that prints ${name} runs nothing and removes nothing`, async () => {
      const box = sandbox("new");
      const keep = join(box.home, "keep-me");
      writeFileSync(keep, "x");
      writeFileSync(join(box.tmp, "keep-me"), "x");
      mkdirSync(join(box.tmp, "plannotator-update-x", "inner"), { recursive: true });
      writeFileSync(join(box.tmp, "plannotator-update-x", "inner", "install.sh"), "x");
      const fakePrepare = join(box.stub, "fake-prepare");
      writeFileSync(fakePrepare, `#!/bin/sh\nprintf '%s\\n' "${printed}"\n`, { mode: 0o755 });
      const r = await runWrapper(box, 9, { PLANNOTATOR_UPDATE_BINARY: fakePrepare, PLANNOTATOR_UPDATE_ENTRY: "" });
      expect(r.result?.exitCode).toBe(UPDATE_PREPARE_FAILED);
      expect(existsSync(keep)).toBe(true);
      expect(existsSync(join(box.tmp, "keep-me"))).toBe(true);
      expect(existsSync(join(box.tmp, "plannotator-update-x", "inner", "install.sh"))).toBe(true);
      expect(r.lockHeld).toBe(false);
    }, 30_000);
  }
});
