import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";

const cliPath = fileURLToPath(new URL("../dist/cli.js", import.meta.url));

interface RunResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

interface ArtifactView {
  readonly artifact: string;
  readonly state: string;
  readonly message: string;
  readonly path: string;
}

function objectRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("expected an object");
  }
  return Object.fromEntries(Object.entries(value));
}

function parsed(text: string): unknown {
  return JSON.parse(text);
}

function parseJson(result: RunResult): Record<string, unknown> {
  assert.equal(result.code, 0, `${result.stderr}\n${result.stdout}`);
  return objectRecord(parsed(result.stdout));
}

function stringField(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string") {
    throw new Error(`expected ${key} to be a string`);
  }
  return value;
}

function booleanField(record: Record<string, unknown>, key: string): boolean {
  const value = record[key];
  if (typeof value !== "boolean") {
    throw new Error(`expected ${key} to be a boolean`);
  }
  return value;
}

function artifactsOf(record: Record<string, unknown>): readonly ArtifactView[] {
  const episode = objectRecord(record["episode"] ?? record);
  const artifacts = episode["artifacts"];
  if (!Array.isArray(artifacts)) {
    throw new Error("episode has no artifacts");
  }
  return artifacts.map((item) => {
    const artifact = objectRecord(item);
    const message = artifact["message"];
    const path = artifact["path"];
    return {
      artifact: stringField(artifact, "artifact"),
      state: stringField(artifact, "state"),
      message: typeof message === "string" ? message : "",
      path: typeof path === "string" ? path : "",
    };
  });
}

function run(env: NodeJS.ProcessEnv, args: readonly string[], timeoutMs: number): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, ...args], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
    }, timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => {
      out.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      err.push(chunk);
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({
        code: code ?? 1,
        stdout: Buffer.concat(out).toString("utf8"),
        stderr: Buffer.concat(err).toString("utf8"),
      });
    });
  });
}

const SPEECH =
  "This is a generated speaker test for PodDrill. The voice stays on long enough to build one embedding stretch from the transcript cues. PodDrill stores the timed text and a speaker vector for this clip.";

function speechWav(path: string): Promise<void> {
  const spoken = `${path}.espeak.wav`;
  return runCommand("espeak-ng", ["-w", spoken, SPEECH]).then(() =>
    runCommand("ffmpeg", [
      "-hide_banner",
      "-loglevel",
      "error",
      "-nostdin",
      "-y",
      "-i",
      spoken,
      "-ac",
      "1",
      "-ar",
      "16000",
      "-c:a",
      "pcm_s16le",
      "-f",
      "wav",
      path,
    ]),
  );
}

function runCommand(command: string, args: readonly string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...args], { stdio: ["ignore", "ignore", "pipe"] });
    const err: Buffer[] = [];
    child.stderr.on("data", (chunk: Buffer) => {
      err.push(chunk);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`${command} exited ${code ?? 1}: ${Buffer.concat(err).toString("utf8")}`));
    });
  });
}

function cleanEnv(home: string, workspace: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: home,
    PODDRILL_WORKSPACE: workspace,
  };
  delete env["PODDRILL_PYTHON"];
  delete env["PODDRILL_EMBED_WEIGHTS"];
  return env;
}

function commandOk(command: string, args: readonly string[]): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (ok: boolean): void => {
      if (settled) {
        return;
      }
      settled = true;
      resolve(ok);
    };
    const child = spawn(command, [...args], { stdio: "ignore" });
    child.on("error", () => {
      finish(false);
    });
    child.on("close", (code) => {
      finish(code === 0);
    });
  });
}

async function smokeSkipReason(): Promise<string | undefined> {
  const probes: readonly (readonly [string, readonly string[]])[] = [
    ["python3", ["-c", "import ensurepip"]],
    ["ffmpeg", ["-version"]],
    ["espeak-ng", ["--version"]],
  ];
  const missing: string[] = [];
  for (const [command, args] of probes) {
    if (!(await commandOk(command, args))) {
      missing.push(command === "python3" ? "python3 with ensurepip" : command);
    }
  }
  if (missing.length === 0) {
    return undefined;
  }
  return `skipped: ${missing.join(", ")} unavailable`;
}

describe("smoke", () => {
  it("transcribes and embeds a generated clip from a clean home", async (t: TestContext) => {
    const reason = await smokeSkipReason();
    if (reason !== undefined) {
      t.skip(reason);
      return;
    }
    const home = await realpath(await mkdtemp(join(tmpdir(), "poddrill-smoke-home-")));
    const workspace = await realpath(await mkdtemp(join(tmpdir(), "poddrill-smoke-ws-")));
    const env = cleanEnv(home, workspace);
    try {
      const installed = parseJson(await run(env, ["install-python"], 600_000));
      assert.equal(stringField(installed, "kind"), "ready");
      assert.equal(stringField(installed, "python"), join(home, ".cache", "poddrill", "venv", "bin", "python"));
      const installer = stringField(installed, "installer");
      assert.ok(installer === "uv" || installer === "venv" || installer === "cached");

      const weights = parseJson(await run(env, ["fetch-weights"], 180_000));
      const ecapa = objectRecord(weights["ecapa"]);
      const segmentation = objectRecord(weights["segmentation"]);
      assert.equal(booleanField(ecapa, "created"), true);
      assert.equal(stringField(ecapa, "sha256"), "f901ae3571912bad4e11e157744cb8b7d77a0b46923b83c410bdbb6c77d69736");
      assert.equal(stringField(ecapa, "license"), "CC BY 4.0");
      assert.equal(booleanField(segmentation, "created"), true);
      assert.equal(stringField(segmentation, "sha256"), "057ee564753071c0b09b5b611648b50ac188d50846bff5f01e9f7bbf1591ea25");
      assert.equal(stringField(segmentation, "license"), "MIT");
      const again = parseJson(await run(env, ["fetch-weights"], 60_000));
      assert.equal(booleanField(objectRecord(again["ecapa"]), "created"), false);
      assert.equal(booleanField(objectRecord(again["segmentation"]), "created"), false);

      const setup = parseJson(await run(env, ["setup", "--provider", "grok-bot", "--queue-length", "1"], 30_000));
      assert.equal(stringField(setup, "kind"), "ready");

      const wav = join(workspace, "audio", "clip.wav");
      await mkdir(join(workspace, "audio"), { recursive: true });
      await speechWav(wav);
      const started = parseJson(await run(env, ["start", wav], 60_000));
      assert.equal(stringField(started, "kind"), "started");
      const episode = objectRecord(started["episode"]);
      const episodeId = stringField(episode, "episodeId");

      let last = "";
      let transcript = "";
      let embedding = "";
      for (let attempt = 0; attempt < 180; attempt += 1) {
        const result = await run(env, ["episode", episodeId], 30_000);
        assert.equal(result.code, 0, result.stderr);
        last = result.stdout;
        const views = artifactsOf(objectRecord(parsed(result.stdout)));
        const transcriptView = views.find((view) => view.artifact === "transcript");
        const embeddingView = views.find((view) => view.artifact === "embedding");
        transcript = transcriptView?.state ?? "";
        embedding = embeddingView?.state ?? "";
        if (transcript === "failed" || embedding === "failed") {
          break;
        }
        if (transcript === "ready" && embedding === "ready") {
          break;
        }
        await delay(2_000);
      }
      assert.equal(transcript, "ready", last);
      assert.equal(embedding, "ready", last);
      const done = artifactsOf(objectRecord(parsed(last)));
      const transcriptPath = done.find((view) => view.artifact === "transcript")?.path ?? "";
      const embeddingPath = done.find((view) => view.artifact === "embedding")?.path ?? "";
      const vtt = await readFile(transcriptPath, "utf8");
      assert.match(vtt, /-->/);
      const embeddingFile = objectRecord(parsed(await readFile(embeddingPath, "utf8")));
      const turns = embeddingFile["turns"];
      if (!Array.isArray(turns) || turns.length < 1) {
        throw new Error(`embedding has no turn: ${await readFile(embeddingPath, "utf8")}`);
      }
      const turn = objectRecord(turns[0]);
      if (typeof turn["speaker"] !== "number" || typeof turn["startMs"] !== "number" || typeof turn["endMs"] !== "number") {
        throw new Error("embedding turn is missing startMs, endMs, or speaker");
      }

      const stopped = parseJson(await run(env, ["stop"], 30_000));
      assert.equal(stringField(stopped, "state"), "stopped");
    } finally {
      await run(env, ["stop"], 15_000).catch(() => undefined);
      await rm(home, { recursive: true, force: true });
      await rm(workspace, { recursive: true, force: true });
    }
  });
});

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
