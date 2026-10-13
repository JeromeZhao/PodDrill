import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { socketPath } from "../src/owner.ts";

const cliPath = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const sampleRate = 16_000;
const macFailure = "cactus-needle is not installed. Run poddrill install-python.";

interface RunResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

function pcmWav(durationMs: number): Buffer {
  const sampleCount = durationMs * (sampleRate / 1000);
  const dataSize = sampleCount * 2;
  const buffer = Buffer.alloc(44 + dataSize);
  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write("WAVE", 8);
  buffer.write("fmt ", 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36);
  buffer.writeUInt32LE(dataSize, 40);
  buffer.writeInt16LE(1, 44);
  return buffer;
}

function episodeIdFor(bytes: Buffer): string {
  return `ep_${createHash("sha256").update(bytes).digest("hex").slice(0, 16)}`;
}

function envFor(root: string): NodeJS.ProcessEnv {
  return { ...process.env, PODDRILL_WORKSPACE: root };
}

function execText(command: string, args: readonly string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(command, [...args], { encoding: "utf8" }, (error, stdout) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(stdout);
    });
  });
}

async function livePython(): Promise<string> {
  const executable = (await execText("python3", ["-c", "import sys; print(sys.executable)"])).trim();
  assert.equal((await execText(executable, ["-c", "print('poddrill-python-ok')"])).trim(), "poddrill-python-ok");
  return executable;
}

function run(
  root: string,
  args: readonly string[],
  extra: NodeJS.ProcessEnv = {},
  omit: readonly string[] = [],
): Promise<RunResult> {
  const env: NodeJS.ProcessEnv = { ...envFor(root), ...extra };
  for (const key of omit) {
    delete env[key];
  }
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--experimental-strip-types", cliPath, ...args], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => {
      out.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      err.push(chunk);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      resolve({
        code: code ?? 1,
        stdout: Buffer.concat(out).toString("utf8"),
        stderr: Buffer.concat(err).toString("utf8"),
      });
    });
  });
}

async function workspace(): Promise<string> {
  return realpath(await mkdtemp(join(tmpdir(), "poddrill-cli-")));
}

function socketPids(sock: string): Promise<readonly number[]> {
  return new Promise((resolve) => {
    execFile("lsof", ["-t", sock], { encoding: "utf8" }, (error, stdout) => {
      if (error || stdout.trim() === "") {
        resolve([]);
        return;
      }
      const pids: number[] = [];
      for (const line of stdout.trim().split("\n")) {
        const pid = Number(line);
        if (Number.isInteger(pid) && pid > 0) {
          pids.push(pid);
        }
      }
      resolve(pids);
    });
  });
}

async function signalOwner(root: string, signal: NodeJS.Signals): Promise<void> {
  for (const pid of await socketPids(socketPath(root))) {
    try {
      process.kill(pid, signal);
    } catch {
      continue;
    }
  }
}

async function waitUntilQuiet(root: string): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if ((await socketPids(socketPath(root))).length === 0) {
      return;
    }
    await delay(20);
  }
  throw new Error("owner still listening");
}

async function stopOwner(root: string): Promise<void> {
  await signalOwner(root, "SIGTERM");
  try {
    await waitUntilQuiet(root);
  } catch {
    await signalOwner(root, "SIGKILL");
    await waitUntilQuiet(root);
  }
}

async function assertNoOwnerLockFiles(root: string): Promise<void> {
  const missing = (error: unknown): boolean =>
    error instanceof Error && "code" in error && error.code === "ENOENT";
  await assert.rejects(access(join(root, ".poddrill.pid")), missing, ".poddrill.pid");
  await assert.rejects(access(`${socketPath(root)}.lock`), missing, "socket lock");
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function line(value: object): string {
  return `${JSON.stringify(value)}\n`;
}

function objectRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("expected an object");
  }
  return Object.fromEntries(Object.entries(value));
}

async function episodeUntil(root: string, episodeId: string, state: string): Promise<string> {
  let last = "";
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const result = await run(root, ["episode", episodeId]);
    last = result.stdout;
    assert.equal(result.code, 0, result.stderr);
    if (result.stdout.includes(`"state":"${state}"`)) {
      return result.stdout;
    }
    await delay(50);
  }
  throw new Error(`episode never reached ${state}: ${last}`);
}

function frame(message: object): Buffer {
  return Buffer.from(`${JSON.stringify(message)}\n`, "utf8");
}

function toolText(buffer: Buffer, id: number): string | undefined {
  let rest = buffer;
  for (;;) {
    const newline = rest.indexOf("\n");
    if (newline === -1) {
      return undefined;
    }
    const line = rest.subarray(0, newline).toString("utf8");
    rest = Buffer.from(rest.subarray(newline + 1));
    if (line.trim() === "") {
      continue;
    }
    const text = textForId(JSON.parse(line), id);
    if (text !== undefined) {
      return text;
    }
  }
}

function textForId(message: unknown, id: number): string | undefined {
  if (typeof message !== "object" || message === null) {
    return undefined;
  }
  const record = Object.fromEntries(Object.entries(message));
  if (record["id"] !== id) {
    return undefined;
  }
  const result = record["result"];
  if (typeof result !== "object" || result === null) {
    return undefined;
  }
  const content = Object.fromEntries(Object.entries(result))["content"];
  if (!Array.isArray(content) || content.length === 0) {
    return undefined;
  }
  const first = content[0];
  if (typeof first !== "object" || first === null) {
    return undefined;
  }
  const text = Object.fromEntries(Object.entries(first))["text"];
  return typeof text === "string" ? text : undefined;
}

function mcpInitialize(root: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--experimental-strip-types", cliPath, "mcp"], {
      env: envFor(root),
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdin = child.stdin;
    const stdout = child.stdout;
    if (stdin === null || stdout === null) {
      reject(new Error("mcp pipes missing"));
      return;
    }
    let settled = false;
    let buffer = Buffer.alloc(0);
    const timer = setTimeout(() => {
      finish(() => {
        child.kill("SIGTERM");
        reject(new Error(`initialize timed out with ${JSON.stringify(buffer.toString("utf8"))}`));
      });
    }, 3000);
    const finish = (action: () => void): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      action();
    };
    stdout.on("data", (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      const newline = buffer.indexOf("\n");
      if (newline === -1) {
        return;
      }
      const line = buffer.subarray(0, newline + 1).toString("utf8");
      finish(() => {
        stdin.end();
        resolve(line);
      });
    });
    child.on("error", (error) => {
      finish(() => {
        reject(error);
      });
    });
    child.on("close", (code) => {
      finish(() => {
        reject(new Error(`mcp exited ${code ?? 1} with ${JSON.stringify(buffer.toString("utf8"))}`));
      });
    });
    stdin.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "grok-shell-poddrill", version: "0" },
        },
      })}\n`,
    );
  });
}

function mcpTools(
  root: string,
  calls: readonly { readonly id: number; readonly name: string; readonly args: object }[],
): Promise<ReadonlyMap<number, string>> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--experimental-strip-types", cliPath, "mcp"], {
      env: envFor(root),
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdout = child.stdout;
    const stdin = child.stdin;
    if (stdout === null || stdin === null) {
      reject(new Error("mcp pipes missing"));
      return;
    }
    let buffer = Buffer.alloc(0);
    const want = new Map<number, string>();
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`mcp timed out with ${buffer.toString("utf8")}`));
    }, 8000);
    stdout.on("data", (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      for (const call of calls) {
        if (want.has(call.id)) {
          continue;
        }
        const text = toolText(buffer, call.id);
        if (text !== undefined) {
          want.set(call.id, text);
        }
      }
      if (want.size === calls.length) {
        clearTimeout(timer);
        stdin.end();
        resolve(want);
      }
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    stdin.write(
      frame({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "poddrill-test", version: "0.0.0" },
        },
      }),
    );
    for (const call of calls) {
      stdin.write(
        frame({
          jsonrpc: "2.0",
          id: call.id,
          method: "tools/call",
          params: { name: call.name, arguments: call.args },
        }),
      );
    }
  });
}

describe("poddrill cli", () => {
  it("stores setup and refuses a change while the owner is alive", async () => {
    const root = await workspace();
    try {
      const ready = await run(root, ["setup", "--provider", "localhost", "--queue-length", "2"]);
      assert.equal(ready.code, 0, ready.stderr);
      assert.equal(ready.stdout, line({ kind: "ready", provider: "localhost", queueLength: 2, fleetLimit: 1, embeddingLimit: 1 }));
      const configPath = join(root, "poddrill.json");
      assert.equal(
        await readFile(configPath, "utf8"),
        `${JSON.stringify({ provider: "localhost", queueLength: 2, fleetLimit: 1, embeddingLimit: 1 }, null, 2)}\n`,
      );

      const unknown = await run(root, ["episode", "not-an-episode"]);
      assert.equal(unknown.code, 0, unknown.stderr);
      assert.equal(unknown.stdout, line({ state: "unknown", episodeId: "not-an-episode" }));
      const oldStyle = await run(root, ["episode", "j0123456789abcdef"]);
      assert.equal(oldStyle.stdout, line({ state: "unknown", episodeId: "j0123456789abcdef" }));
      await assertNoOwnerLockFiles(root);

      const before = await readFile(configPath);
      const same = await run(root, ["setup", "--provider", "localhost", "--queue-length", "2"]);
      assert.equal(same.code, 0, same.stderr);
      assert.equal(same.stdout, line({ kind: "ready", provider: "localhost", queueLength: 2, fleetLimit: 1, embeddingLimit: 1 }));
      assert.deepEqual(await readFile(configPath), before);

      const refusal = line({
        kind: "rejected",
        reason: "owner-running",
        provider: "localhost",
        queueLength: 2,
        fleetLimit: 1,
        embeddingLimit: 1,
        message: [
          "poddrill serve is running with provider localhost, queue length 2, fleet limit 1,",
          "and embedding limit 1.",
          "Stop it with poddrill stop before changing the setup.",
        ].join(" "),
      });
      const refused = await run(root, ["setup", "--provider", "localhost", "--queue-length", "3"]);
      assert.equal(refused.code, 1, refused.stderr);
      assert.equal(refused.stdout, refusal);
      assert.deepEqual(await readFile(configPath), before);

      const limitRefused = await run(root, [
        "setup",
        "--provider",
        "localhost",
        "--queue-length",
        "2",
        "--whistle-limit",
        "2",
      ]);
      assert.equal(limitRefused.code, 1, limitRefused.stderr);
      assert.equal(limitRefused.stdout, refusal);
      assert.deepEqual(await readFile(configPath), before);

      const embeddingRefused = await run(root, [
        "setup",
        "--provider",
        "localhost",
        "--queue-length",
        "2",
        "--embedding-limit",
        "2",
      ]);
      assert.equal(embeddingRefused.code, 1, embeddingRefused.stderr);
      assert.equal(embeddingRefused.stdout, refusal);
      assert.deepEqual(await readFile(configPath), before);
    } finally {
      await stopOwner(root);
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps both limits across setup and reads a file without them as 1", async () => {
    const root = await workspace();
    try {
      const configPath = join(root, "poddrill.json");
      const oldFile = `${JSON.stringify({ provider: "localhost", queueLength: 2 }, null, 2)}\n`;
      await writeFile(configPath, oldFile);
      const old = await run(root, ["setup", "--provider", "localhost", "--queue-length", "2"]);
      assert.equal(old.code, 0, old.stderr);
      assert.equal(old.stdout, line({ kind: "ready", provider: "localhost", queueLength: 2, fleetLimit: 1, embeddingLimit: 1 }));
      assert.equal(await readFile(configPath, "utf8"), oldFile);

      const raised = await run(root, [
        "setup",
        "--provider",
        "localhost",
        "--queue-length",
        "2",
        "--whistle-limit",
        "3",
        "--embedding-limit",
        "2",
      ]);
      assert.equal(raised.code, 0, raised.stderr);
      assert.equal(
        raised.stdout,
        line({ kind: "ready", provider: "localhost", queueLength: 2, fleetLimit: 3, embeddingLimit: 2 }),
      );
      const raisedFile = `${JSON.stringify(
        { provider: "localhost", queueLength: 2, fleetLimit: 3, embeddingLimit: 2 },
        null,
        2,
      )}\n`;
      assert.equal(await readFile(configPath, "utf8"), raisedFile);

      const kept = await run(root, ["setup", "--provider", "localhost", "--queue-length", "4"]);
      assert.equal(kept.code, 0, kept.stderr);
      assert.equal(
        kept.stdout,
        line({ kind: "ready", provider: "localhost", queueLength: 4, fleetLimit: 3, embeddingLimit: 2 }),
      );

      const usage = line({
        kind: "error",
        message: [
          "usage: poddrill setup --provider <id> --queue-length <n> [--fleet-limit <n>] [--whistle-limit <n>]",
          "[--model-fleet <id>=<count>] [--model-weights <id>=<path>] [--embedding-limit <n>] [--python <path>]",
          "| install-python | fetch-weights | bootstrap [--provider <id>] [--queue-length <n>]",
          "| start <path> [--language <code>] | episode <episodeId> | cues <episodeId> [--limit <n>] [--after <cueId>] [--group-id <id>] [--hosts]",
          "| label-groups <episodeId> <json> | start-summary <episodeId> | set-summary <episodeId> <summaryId> <json>",
          "| put-paragraph <episodeId> <summaryId> <json> | post-paragraph <episodeId> <summaryId> <json> | summary <episodeId> <summaryId> | audit <episodeId>",
          "| serve | stop | mcp [--selftest] | --help | --version",
        ].join(" "),
      });
      for (const bad of [
        ["--whistle-limit", "0"],
        ["--whistle-limit", "1.5"],
        ["--whistle-limit"],
        ["--embedding-limit", "0"],
        ["--embedding-limit"],
      ]) {
        const rejected = await run(root, ["setup", "--provider", "localhost", "--queue-length", "2", ...bad]);
        assert.equal(rejected.code, 1, rejected.stderr);
        assert.equal(rejected.stdout, usage);
      }

      await writeFile(
        configPath,
        `${JSON.stringify({ provider: "localhost", queueLength: 2, fleetLimit: 1, embeddingLimit: 0 })}\n`,
      );
      const repaired = await run(root, ["setup", "--provider", "localhost", "--queue-length", "2"]);
      assert.equal(repaired.code, 0, repaired.stderr);
      assert.equal(repaired.stdout, line({ kind: "ready", provider: "localhost", queueLength: 2, fleetLimit: 1, embeddingLimit: 1 }));
      assert.equal(
        await readFile(configPath, "utf8"),
        `${JSON.stringify({ provider: "localhost", queueLength: 2, fleetLimit: 1, embeddingLimit: 1 }, null, 2)}\n`,
      );

      const legacy = `${JSON.stringify({ provider: "localhost", queueLength: 2, whistleLimit: 5, embeddingLimit: 1 }, null, 2)}\n`;
      await writeFile(configPath, legacy);
      const loaded = await run(root, ["setup", "--provider", "localhost", "--queue-length", "2"]);
      assert.equal(loaded.code, 0, loaded.stderr);
      assert.equal(
        loaded.stdout,
        line({ kind: "ready", provider: "localhost", queueLength: 2, fleetLimit: 5, embeddingLimit: 1 }),
      );
      assert.equal(await readFile(configPath, "utf8"), legacy);

      const differed = await run(root, [
        "setup",
        "--provider",
        "localhost",
        "--queue-length",
        "2",
        "--fleet-limit",
        "1",
        "--whistle-limit",
        "2",
      ]);
      assert.equal(differed.code, 1, differed.stderr);
      assert.equal(differed.stdout, line({ kind: "error", message: "fleet limit 1 and whistle limit 2 differ" }));
      assert.equal(await readFile(configPath, "utf8"), legacy);

      const mapped = await run(root, [
        "setup",
        "--provider",
        "localhost",
        "--queue-length",
        "2",
        "--fleet-limit",
        "1",
        "--model-fleet",
        "moonshine-tiny-ja=4",
        "--model-weights",
        "moonshine-tiny-ko=/tmp/pw-ko",
      ]);
      assert.equal(mapped.code, 0, mapped.stderr);
      assert.equal(
        mapped.stdout,
        line({ kind: "ready", provider: "localhost", queueLength: 2, fleetLimit: 1, embeddingLimit: 1 }),
      );
      const mappedFile = `${JSON.stringify(
        {
          provider: "localhost",
          queueLength: 2,
          fleetLimit: 1,
          modelFleet: { "moonshine-tiny-ja": 4 },
          modelWeights: { "moonshine-tiny-ko": "/tmp/pw-ko" },
          embeddingLimit: 1,
        },
        null,
        2,
      )}\n`;
      assert.equal(await readFile(configPath, "utf8"), mappedFile);
      const mappedBytes = await readFile(configPath);
      const again = await run(root, [
        "setup",
        "--provider",
        "localhost",
        "--queue-length",
        "2",
        "--fleet-limit",
        "1",
        "--model-fleet",
        "moonshine-tiny-ja=4",
        "--model-weights",
        "moonshine-tiny-ko=/tmp/pw-ko",
      ]);
      assert.equal(again.code, 0, again.stderr);
      assert.deepEqual(await readFile(configPath), mappedBytes);

      const unknownModel = await run(root, [
        "setup",
        "--provider",
        "localhost",
        "--queue-length",
        "2",
        "--model-fleet",
        "not-a-model=1",
      ]);
      assert.equal(unknownModel.code, 1, unknownModel.stderr);
      assert.equal(unknownModel.stdout, line({ kind: "error", message: "unknown model not-a-model" }));
      assert.deepEqual(await readFile(configPath), mappedBytes);

      const relative = await run(root, [
        "setup",
        "--provider",
        "localhost",
        "--queue-length",
        "2",
        "--model-weights",
        "whistle=weights/whistle",
      ]);
      assert.equal(relative.code, 1, relative.stderr);
      assert.equal(
        relative.stdout,
        line({ kind: "error", message: "model weights path for whistle must be absolute, got weights/whistle" }),
      );
      assert.deepEqual(await readFile(configPath), mappedBytes);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("starts a generated wav and prints the same JSON from the CLI and MCP", async () => {
    const root = await workspace();
    try {
      const setup = await run(root, ["setup", "--provider", "localhost", "--queue-length", "2"]);
      assert.equal(setup.code, 0, setup.stderr);
      const bytes = pcmWav(1000);
      const episodeId = episodeIdFor(bytes);
      await writeFile(join(root, "audio", "clip.wav"), bytes);
      const sourcePath = join(root, "episodes", episodeId, "source.wav");
      const waiting = { artifact: "embedding", state: "waiting", on: "transcript" };
      const runningEpisode = {
        state: "present",
        episodeId,
        sourcePath,
        durationMs: 1000,
        language: "en",
        artifacts: [{ artifact: "transcript", state: "running", progress: 0 }, waiting],
        summaries: [],
      };
      const started = await run(root, ["start", "audio/clip.wav"]);
      assert.equal(started.code, 0, started.stderr);
      assert.equal(started.stdout, line({ kind: "started", created: true, episode: runningEpisode }));
      for (const hidden of ["wavPath", "whistlePath", "slicesDone", "slicesTotal", "work", "jobId"]) {
        assert.equal(started.stdout.includes(hidden), false, hidden);
      }

      const failed = line({
        state: "present",
        episodeId,
        sourcePath,
        durationMs: 1000,
        language: "en",
        artifacts: [
          { artifact: "transcript", state: "failed", progress: 0, message: macFailure },
          waiting,
        ],
        summaries: [],
      });
      assert.equal(await episodeUntil(root, episodeId, "failed"), failed);
      await assertNoOwnerLockFiles(root);

      const tools = await mcpTools(root, [
        { id: 2, name: "episode", args: { episodeId } },
        { id: 3, name: "start", args: { path: "audio/clip.wav" } },
      ]);
      assert.equal(tools.get(2), failed);
      assert.equal(tools.get(3), line({ kind: "started", created: false, episode: runningEpisode }));

      const outside = join(root, "clip.wav");
      await writeFile(outside, bytes);
      const beforeEpisodes = await readdir(join(root, "episodes"));
      const rejected = await run(root, ["start", outside]);
      assert.equal(rejected.code, 1, rejected.stderr);
      assert.equal(
        rejected.stdout,
        line({
          kind: "rejected",
          reason: "outside-audio-dir",
          message: `${outside} is not under ${join(root, "audio")}. Save the episode audio there first.`,
        }),
      );
      assert.deepEqual(await readdir(join(root, "episodes")), beforeEpisodes);

      await signalOwner(root, "SIGKILL");
      await waitUntilQuiet(root);
      const restarted = await run(root, ["episode", episodeId]);
      assert.equal(restarted.code, 0, restarted.stderr);
      assert.equal(await episodeUntil(root, episodeId, "failed"), failed);
      await assertNoOwnerLockFiles(root);
    } finally {
      await stopOwner(root);
      await rm(root, { recursive: true, force: true });
    }
  });

  it("prints progress 100 and both artifact paths for a finished episode", async () => {
    const root = await workspace();
    try {
      const setup = await run(root, ["setup", "--provider", "localhost", "--queue-length", "2"]);
      assert.equal(setup.code, 0, setup.stderr);
      const episodeId = "ep_0123456789abcdef";
      const dir = join(root, "episodes", episodeId);
      await mkdir(join(dir, "transcript"), { recursive: true });
      await mkdir(join(dir, "embedding"), { recursive: true });
      const manifest = {
        episodeId,
        sha256: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        sourceName: "clip.wav",
        sourceFile: "source.wav",
        durationMs: 1000,
        enqueuedAt: "2026-01-01T00:00:00.000Z",
      };
      await writeFile(join(dir, "episode.json"), `${JSON.stringify(manifest, null, 2)}\n`);
      await writeFile(join(dir, "transcript", "transcript.vtt"), "WEBVTT\n");
      await writeFile(join(dir, "embedding", "embedding.json"), "{\"stretches\":[]}\n");
      await writeFile(join(dir, "groups.json"), "{\"cues\":[]}\n");
      const read = await run(root, ["episode", episodeId]);
      assert.equal(read.code, 0, read.stderr);
      assert.equal(
        read.stdout,
        line({
          state: "present",
          episodeId,
          sourcePath: join(dir, "source.wav"),
          durationMs: 1000,
          language: "en",
          artifacts: [
            { artifact: "transcript", state: "ready", progress: 100, path: join(dir, "transcript", "transcript.vtt") },
            { artifact: "embedding", state: "ready", progress: 100, path: join(dir, "embedding", "embedding.json") },
          ],
          summaries: [],
        }),
      );
      const tools = await mcpTools(root, [{ id: 2, name: "episode", args: { episodeId } }]);
      assert.equal(tools.get(2), read.stdout);
      await assertNoOwnerLockFiles(root);
    } finally {
      await stopOwner(root);
      await rm(root, { recursive: true, force: true });
    }
  });

  it("dumps the start line and does not append on a second audit", async () => {
    const root = await workspace();
    try {
      const missing = await run(root, ["audit"]);
      assert.equal(missing.code, 1);
      assert.equal(
        missing.stdout,
        line({
          kind: "error",
          message: [
            "usage: poddrill setup --provider <id> --queue-length <n> [--fleet-limit <n>] [--whistle-limit <n>]",
            "[--model-fleet <id>=<count>] [--model-weights <id>=<path>] [--embedding-limit <n>] [--python <path>]",
            "| install-python | fetch-weights | bootstrap [--provider <id>] [--queue-length <n>]",
            "| start <path> [--language <code>] | episode <episodeId> | cues <episodeId> [--limit <n>] [--after <cueId>] [--group-id <id>] [--hosts]",
            "| label-groups <episodeId> <json> | start-summary <episodeId> | set-summary <episodeId> <summaryId> <json>",
            "| put-paragraph <episodeId> <summaryId> <json> | post-paragraph <episodeId> <summaryId> <json> | summary <episodeId> <summaryId> | audit <episodeId>",
            "| serve | stop | mcp [--selftest] | --help | --version",
          ].join(" "),
        }),
      );
      const setup = await run(root, ["setup", "--provider", "localhost", "--queue-length", "2"]);
      assert.equal(setup.code, 0, setup.stderr);
      const bytes = pcmWav(1000);
      const episodeId = episodeIdFor(bytes);
      await writeFile(join(root, "audio", "clip.wav"), bytes);
      const started = await run(root, ["start", "audio/clip.wav"]);
      assert.equal(started.code, 0, started.stderr);
      const first = await run(root, ["audit", episodeId]);
      assert.equal(first.code, 0, first.stderr);
      const dumped = objectRecord(JSON.parse(first.stdout));
      assert.equal(dumped["state"], "present");
      assert.equal(dumped["episodeId"], episodeId);
      assert.deepEqual(Object.keys(dumped).sort(), ["episodeId", "records", "state"]);
      const records = dumped["records"];
      if (!Array.isArray(records)) {
        throw new Error("audit records");
      }
      assert.equal(records.length, 1);
      const record = objectRecord(records[0]);
      assert.deepEqual(Object.keys(record).sort(), ["at", "op", "request", "result"]);
      assert.equal(record["op"], "start");
      assert.deepEqual(record["request"], { language: "en" });
      assert.deepEqual(record["result"], { kind: "started", created: true });
      const at = record["at"];
      assert.equal(typeof at, "string");
      if (typeof at !== "string") {
        return;
      }
      assert.match(at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
      const auditPath = join(root, "episodes", episodeId, "audit.jsonl");
      const before = await readFile(auditPath);
      const second = await run(root, ["audit", episodeId]);
      assert.equal(second.code, 0, second.stderr);
      assert.equal(second.stdout, first.stdout);
      assert.deepEqual(await readFile(auditPath), before);
      const unknownId = "ep_0000000000000000";
      const unknown = await run(root, ["audit", unknownId]);
      assert.equal(unknown.code, 0, unknown.stderr);
      assert.equal(unknown.stdout, line({ state: "unknown", episodeId: unknownId }));
      assert.deepEqual(await readdir(join(root, "episodes")), [episodeId]);
    } finally {
      await stopOwner(root);
      await rm(root, { recursive: true, force: true });
    }
  });

  it("prints help and version on exit 0", async () => {
    const root = await workspace();
    try {
      const help = await run(root, ["--help"]);
      assert.equal(help.code, 0, help.stderr);
      assert.equal(help.stdout.includes("install-python"), true);
      assert.equal(help.stdout.includes("fetch-weights"), true);
      assert.equal(help.stdout.includes("stop"), true);
      assert.equal(help.stdout.includes("\n"), true);
      const version = await run(root, ["--version"]);
      assert.equal(version.code, 0, version.stderr);
      const manifest = objectRecord(JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")));
      const packageVersion = manifest["version"];
      assert.equal(typeof packageVersion, "string");
      if (typeof packageVersion !== "string") {
        return;
      }
      assert.equal(version.stdout, `poddrill ${packageVersion}\n`);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("answers a newline initialize", async () => {
    const root = await workspace();
    try {
      const setup = await run(root, ["setup", "--provider", "localhost", "--queue-length", "1"]);
      assert.equal(setup.code, 0, setup.stderr);
      const manifest = objectRecord(JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")));
      const packageVersion = manifest["version"];
      assert.equal(typeof packageVersion, "string");
      if (typeof packageVersion !== "string") {
        return;
      }
      const stdout = await mcpInitialize(root);
      assert.equal(
        stdout,
        `${JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          result: {
            protocolVersion: "2024-11-05",
            capabilities: { tools: {} },
            serverInfo: { name: "poddrill", version: packageVersion },
          },
        })}\n`,
      );
    } finally {
      await stopOwner(root);
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps paragraph cues when the owner is already running", async () => {
    const root = await workspace();
    const episodeId = "ep_0123456789abcdef";
    const summaryId = "sm_6b7be0fd5a237c45";
    const paragraph = {
      text: "The guest says the city allows too few new homes.",
      cues: ["c0002", "c0005"],
    };
    const unknown = line({ state: "unknown", episodeId });
    try {
      const setup = await run(root, ["setup", "--provider", "localhost", "--queue-length", "1"]);
      assert.equal(setup.code, 0, setup.stderr);
      const posted = await run(root, ["post-paragraph", episodeId, summaryId, JSON.stringify(paragraph)]);
      assert.equal(posted.stdout, unknown);
      assert.equal(posted.code, 0, posted.stderr);
      const replaced = await run(root, [
        "put-paragraph",
        episodeId,
        summaryId,
        JSON.stringify({ index: 1, ...paragraph }),
      ]);
      assert.equal(replaced.code, 0, replaced.stderr);
      assert.equal(replaced.stdout, unknown);
      const tools = await mcpTools(root, [
        { id: 2, name: "postParagraph", args: { episodeId, summaryId, ...paragraph } },
      ]);
      assert.equal(tools.get(2), unknown);
    } finally {
      await stopOwner(root);
      await rm(root, { recursive: true, force: true });
    }
  });

  it("setup defaults to ~/poddrill and accepts grok-bot", async () => {
    const home = await workspace();
    try {
      const ready = await run(home, ["setup", "--provider", "grok-bot", "--queue-length", "1"], {
        HOME: home,
        PODDRILL_WORKSPACE: "",
      });
      assert.equal(ready.code, 0, ready.stderr);
      assert.equal(ready.stdout, line({ kind: "ready", provider: "grok-bot", queueLength: 1, fleetLimit: 1, embeddingLimit: 1 }));
      const config = objectRecord(JSON.parse(await readFile(join(home, "poddrill", "poddrill.json"), "utf8")));
      assert.equal(config["provider"], "grok-bot");
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("records an absolute python and mcp --selftest reports that env", async () => {
    const root = await workspace();
    const python = await livePython();
    try {
      const ready = await run(root, ["setup", "--provider", "cursor-cloud", "--queue-length", "1"], {
        PODDRILL_PYTHON: python,
      });
      assert.equal(ready.code, 0, ready.stderr);
      assert.equal(
        ready.stdout,
        line({
          kind: "ready",
          provider: "cursor-cloud",
          queueLength: 1,
          fleetLimit: 1,
          embeddingLimit: 1,
          python,
        }),
      );
      const stored = objectRecord(JSON.parse(await readFile(join(root, "poddrill.json"), "utf8")));
      assert.equal(stored["python"], python);
      const selftest = await run(root, ["mcp", "--selftest"], { PODDRILL_PYTHON: python });
      assert.equal(selftest.code, 0, selftest.stderr);
      const body = objectRecord(JSON.parse(selftest.stdout));
      const seen = objectRecord(body["env"]);
      assert.equal(body["kind"], "ready");
      assert.equal(body["execPath"], process.execPath);
      assert.equal(seen["PODDRILL_PYTHON"], python);
      assert.equal(seen["PODDRILL_WORKSPACE"], root);
      assert.equal((await execText(python, ["-c", "print('poddrill-python-ok')"])).trim(), "poddrill-python-ok");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("mcp --selftest uses the python stored in poddrill.json", async () => {
    const root = await workspace();
    const python = await livePython();
    try {
      const ready = await run(
        root,
        ["setup", "--provider", "localhost", "--queue-length", "1", "--python", python],
        {},
        ["PODDRILL_PYTHON"],
      );
      assert.equal(ready.code, 0, ready.stderr);
      const stored = objectRecord(JSON.parse(await readFile(join(root, "poddrill.json"), "utf8")));
      assert.equal(stored["python"], python);
      const selftest = await run(root, ["mcp", "--selftest"], {}, ["PODDRILL_PYTHON"]);
      assert.equal(selftest.code, 0, selftest.stderr);
      const body = objectRecord(JSON.parse(selftest.stdout));
      const seen = objectRecord(body["env"]);
      const reported = seen["PODDRILL_PYTHON"];
      assert.equal(reported, python);
      if (typeof reported !== "string") {
        return;
      }
      assert.equal((await execText(reported, ["-c", "print('poddrill-python-ok')"])).trim(), "poddrill-python-ok");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("stop ends a running owner and is safe when none is running", async () => {
    const root = await workspace();
    try {
      const setup = await run(root, ["setup", "--provider", "localhost", "--queue-length", "1"]);
      assert.equal(setup.code, 0, setup.stderr);
      const idle = await run(root, ["stop"]);
      assert.equal(idle.code, 0, idle.stderr);
      assert.equal(idle.stdout, line({ kind: "ready", state: "stopped" }));
      const episode = await run(root, ["episode", "ep_0000000000000000"]);
      assert.equal(episode.code, 0, episode.stderr);
      const stopped = await run(root, ["stop"]);
      assert.equal(stopped.code, 0, stopped.stderr);
      assert.equal(stopped.stdout, line({ kind: "ready", state: "stopped" }));
      await waitUntilQuiet(root);
    } finally {
      await stopOwner(root);
      await rm(root, { recursive: true, force: true });
    }
  });
});
