import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { probeDurationMs } from "../src/audio.ts";
import { openDiarizeHost, type DiarizeCall } from "../src/diarize.ts";
import type { EmbedCall } from "../src/embed.ts";
import { EpisodeTime, planSlices, projectSlices, type WhistleResult } from "../src/episode.ts";
import { fleetSize, modelForLanguage } from "../src/models.ts";
import { moonshineToWhistle } from "../src/moonshine.ts";
import { spawnNeedleWorker } from "../src/needle.ts";
import {
  JobQueue,
  type ArtifactRecord,
  type ArtifactState,
  type Episode,
  type EpisodeRead,
} from "../src/jobs.ts";
import { openWhistleCall, type WhistleCall } from "../src/provider.ts";
import {
  episodeIdFromDigest,
  readConfig,
  setupWorkspace,
  workspaceDirs,
  type ArtifactKind,
  type EpisodeId,
  type WorkspaceConfig,
  type WorkspaceRoot,
} from "../src/workspace.ts";

const SAMPLE_RATE = 16_000;

function pcmWav(durationMs: number, mark: number): Buffer {
  const sampleCount = durationMs * (SAMPLE_RATE / 1000);
  const dataSize = sampleCount * 2;
  const buffer = Buffer.alloc(44 + dataSize);
  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write("WAVE", 8);
  buffer.write("fmt ", 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(SAMPLE_RATE, 24);
  buffer.writeUInt32LE(SAMPLE_RATE * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36);
  buffer.writeUInt32LE(dataSize, 40);
  buffer.writeInt16LE(mark, 44);
  return buffer;
}

function episodeIdFor(bytes: Buffer): EpisodeId {
  return episodeIdFromDigest(createHash("sha256").update(bytes).digest("hex"));
}

function readMessage(value: unknown): string {
  if (typeof value !== "object" || value === null || !("message" in value)) {
    throw new Error("failed.json missing message");
  }
  const message = value.message;
  if (typeof message !== "string") {
    throw new Error("failed.json message is not a string");
  }
  return message;
}

function hello(): WhistleResult {
  return {
    kind: "speech",
    text: "Hello.",
    language: "en",
    ttftMs: 1,
    decodeTps: 1,
    words: [{ word: "Hello.", start: 0.1, end: 0.4, probability: 0.9 }],
  };
}

function cues(starts: readonly number[]): WhistleResult {
  return {
    kind: "speech",
    text: "spoken",
    language: "en",
    ttftMs: 1,
    decodeTps: 1,
    words: starts.flatMap((start) => [
      { word: "talk", start: start + 0.1, end: start + 0.4, probability: 0.9 },
      { word: "done.", start: start + 4.6, end: start + 5.0, probability: 0.9 },
    ]),
  };
}

function vector(value: number): readonly number[] {
  return Array.from({ length: 192 }, () => value);
}

function isEnoent(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error: unknown) {
    if (isEnoent(error)) {
      return false;
    }
    throw error;
  }
}

async function waitFor(check: () => Promise<boolean> | boolean): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (await check()) {
      return;
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 10);
    });
  }
  throw new Error("timed out");
}

interface Workspace {
  readonly dir: string;
  readonly root: WorkspaceRoot;
  readonly config: WorkspaceConfig;
  readonly audioDir: string;
  readonly cleanup: () => Promise<void>;
}

async function openWorkspace(queueLength: number, fleetLimit = 1, embeddingLimit = 1): Promise<Workspace> {
  const dir = await mkdtemp(join(tmpdir(), "poddrill-jobs-"));
  const setup = await setupWorkspace({
    root: dir,
    provider: "localhost",
    queueLength,
    fleetLimit,
    embeddingLimit,
    ownerAlive: false,
  });
  if (setup.kind !== "ready") {
    throw new Error(setup.message);
  }
  return {
    dir,
    root: setup.report.dirs.root,
    config: setup.report.config,
    audioDir: setup.report.dirs.audioDir,
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}

const instantEmbed: EmbedCall = {
  async prepare(): Promise<void> {},
  async embedStretch(): Promise<readonly number[]> {
    return vector(7);
  },
};

function clipDiarize(): DiarizeCall {
  return {
    async prepare(): Promise<void> {},
    async diarize(sourcePath: string) {
      const durationMs = await probeDurationMs(sourcePath);
      if (durationMs === undefined || durationMs < 1) {
        throw new Error("diarize fixture has no audio");
      }
      return {
        turns: [{ startMs: 0, endMs: durationMs, speaker: 0 }],
        centroids: [vector(1)],
      };
    },
  };
}

function openQueue(
  workspace: Workspace,
  whistle: WhistleCall,
  embed: EmbedCall = instantEmbed,
  config: WorkspaceConfig = workspace.config,
  diarize: DiarizeCall = clipDiarize(),
): Promise<JobQueue> {
  return JobQueue.open(workspace.root, config, { whistle, embed, diarize });
}

function episodeDir(root: WorkspaceRoot, id: EpisodeId): string {
  return join(workspaceDirs(root).episodesDir, id);
}

function sourcePath(root: WorkspaceRoot, id: EpisodeId): string {
  return join(episodeDir(root, id), "source.wav");
}

function transcriptFile(root: WorkspaceRoot, id: EpisodeId, name: string): string {
  return join(episodeDir(root, id), "transcript", name);
}

function embeddingFile(root: WorkspaceRoot, id: EpisodeId, name: string): string {
  return join(episodeDir(root, id), "embedding", name);
}

function sliceFile(root: WorkspaceRoot, id: EpisodeId, name: string): string {
  return join(episodeDir(root, id), "transcript", "work", name);
}

async function sliceNames(root: WorkspaceRoot, id: EpisodeId): Promise<readonly string[]> {
  return (await readdir(join(episodeDir(root, id), "transcript", "work"))).sort();
}

const WAITING: ArtifactState = { state: "waiting", on: "transcript" };

function present(
  workspace: Workspace,
  id: EpisodeId,
  durationMs: number,
  transcript: ArtifactState,
  embedding: ArtifactState,
  language = "en",
): Episode {
  return {
    state: "present",
    episodeId: id,
    sourcePath: sourcePath(workspace.root, id),
    durationMs,
    language,
    artifacts: [
      { artifact: "transcript", ...transcript },
      { artifact: "embedding", ...embedding },
    ],
    summaries: [],
  };
}

function transcriptReady(workspace: Workspace, id: EpisodeId): ArtifactState {
  return { state: "ready", progress: 100, path: transcriptFile(workspace.root, id, "transcript.vtt") };
}

function embeddingReady(workspace: Workspace, id: EpisodeId): ArtifactState {
  return { state: "ready", progress: 100, path: embeddingFile(workspace.root, id, "embedding.json") };
}

function artifactOf(read: EpisodeRead, kind: ArtifactKind): ArtifactRecord | undefined {
  return read.state === "present" ? read.artifacts.find((entry) => entry.artifact === kind) : undefined;
}

function stateOf(read: EpisodeRead, kind: ArtifactKind): string | undefined {
  return artifactOf(read, kind)?.state;
}

function progressOf(read: EpisodeRead, kind: ArtifactKind): number | undefined {
  const found = artifactOf(read, kind);
  if (found === undefined || found.state === "waiting") {
    return undefined;
  }
  return found.progress;
}

function bothReady(queue: JobQueue, id: EpisodeId): boolean {
  const read = queue.episode(id);
  return stateOf(read, "transcript") === "ready" && stateOf(read, "embedding") === "ready";
}

const FOUR_SLICES_MS = 90_000;

const ALL_SLICE_FILES = [
  "0000.wav",
  "0000.whistle.json",
  "0001.wav",
  "0001.whistle.json",
  "0002.wav",
  "0002.whistle.json",
  "0003.wav",
  "0003.whistle.json",
];

/** A distinct word per slice, so the VTT shows which slice each cue came from. */
function spoken(sliceIndex: number): WhistleResult {
  return {
    kind: "speech",
    text: `slice${sliceIndex}.`,
    language: "en",
    ttftMs: 1,
    decodeTps: 1,
    words: [{ word: `slice${sliceIndex}.`, start: 0.1, end: 0.4, probability: 0.9 }],
  };
}

interface Recorder {
  readonly whistle: WhistleCall;
  readonly calls: number[];
  readonly wavs: Map<number, Buffer>;
}

function recorder(): Recorder {
  const calls: number[] = [];
  const wavs = new Map<number, Buffer>();
  return {
    calls,
    wavs,
    whistle: {
      async transcribeSlice(job): Promise<WhistleResult> {
        calls.push(job.sliceIndex);
        wavs.set(job.sliceIndex, await readFile(job.wavPath));
        return spoken(job.sliceIndex);
      },
    },
  };
}

interface Gate<T> {
  readonly resolve: (result: T) => void;
  readonly reject: (error: Error) => void;
}

interface Gated {
  readonly whistle: WhistleCall;
  readonly gates: Map<number, Gate<WhistleResult>>;
  readonly settled: number[];
  readonly peak: () => number;
}

/** Each call waits until the test opens its slice's gate. */
function gated(): Gated {
  const gates = new Map<number, Gate<WhistleResult>>();
  const settled: number[] = [];
  let inFlight = 0;
  let peak = 0;
  return {
    gates,
    settled,
    peak: () => peak,
    whistle: {
      async transcribeSlice(job): Promise<WhistleResult> {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        try {
          return await new Promise<WhistleResult>((resolve, reject) => {
            gates.set(job.sliceIndex, { resolve, reject });
          });
        } finally {
          inFlight -= 1;
          settled.push(job.sliceIndex);
        }
      },
    },
  };
}

function gate<K, T>(gates: ReadonlyMap<K, Gate<T>>, key: K): Gate<T> {
  const found = gates.get(key);
  if (found === undefined) {
    throw new Error(`${String(key)} never reached the host`);
  }
  return found;
}

/** Run one audio file to ready at limit 1 and return its episode id and VTT bytes. */
async function completeAtLimitOne(
  workspace: Workspace,
  durationMs: number,
  mark: number,
): Promise<{ readonly episodeId: EpisodeId; readonly vtt: Buffer }> {
  const queue = await openQueue(workspace, recorder().whistle);
  try {
    const bytes = pcmWav(durationMs, mark);
    const episodeId = episodeIdFor(bytes);
    const path = join(workspace.audioDir, `audio-${mark}.wav`);
    await writeFile(path, bytes);
    await queue.start(path);
    await waitFor(() => bothReady(queue, episodeId));
    return { episodeId, vtt: await readFile(transcriptFile(workspace.root, episodeId, "transcript.vtt")) };
  } finally {
    await queue.close();
  }
}

async function referenceVtt(durationMs: number, mark: number): Promise<Buffer> {
  const workspace = await openWorkspace(1);
  try {
    return (await completeAtLimitOne(workspace, durationMs, mark)).vtt;
  } finally {
    await workspace.cleanup();
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

describe("JobQueue", () => {
  it("resumes a one-slice episode after close and reports progress 100", async () => {
    const workspace = await openWorkspace(2);
    let release = (): void => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered = false;
    let settled = false;
    const blocking: WhistleCall = {
      async transcribeSlice(): Promise<WhistleResult> {
        entered = true;
        try {
          await held;
          throw new Error("slice interrupted");
        } finally {
          settled = true;
        }
      },
    };
    const queue = await openQueue(workspace, blocking);
    let resumed: JobQueue | undefined;
    try {
      const bytes = pcmWav(1_000, 1);
      const id = episodeIdFor(bytes);
      assert.match(id, /^ep_[0-9a-f]{16}$/);
      const wavPath = join(workspace.audioDir, "one.wav");
      await writeFile(wavPath, bytes);
      const started = await queue.start(wavPath);
      assert.deepEqual(started, {
        kind: "started",
        created: true,
        episode: present(workspace, id, 1_000, { state: "running", progress: 0 }, WAITING),
      });
      await waitFor(() => entered);
      assert.equal(await fileExists(sliceFile(workspace.root, id, "0000.wav")), true);
      assert.deepEqual(
        queue.episode(id),
        present(workspace, id, 1_000, { state: "running", progress: 0 }, WAITING),
      );
      await queue.close();
      release();
      await waitFor(() => settled);
      await new Promise((resolve) => {
        setImmediate(resolve);
      });
      const reopened = await openQueue(workspace, {
        async transcribeSlice(): Promise<WhistleResult> {
          return hello();
        },
      });
      resumed = reopened;
      await waitFor(() => bothReady(reopened, id));
      const done = reopened.episode(id);
      const expected = present(workspace, id, 1_000, transcriptReady(workspace, id), embeddingReady(workspace, id));
      assert.deepEqual(done, expected);
      const text = JSON.stringify(done);
      for (const hidden of ["wavPath", "whistlePath", "slicesDone", "slicesTotal", "vttPath", "work"]) {
        assert.equal(text.includes(hidden), false, hidden);
      }
      const vtt = await readFile(transcriptFile(workspace.root, id, "transcript.vtt"), "utf8");
      assert.equal(vtt, "WEBVTT\n\nc0001\n00:00:00.100 --> 00:00:00.400\nHello.\n");
      assert.deepEqual(JSON.parse(await readFile(embeddingFile(workspace.root, id, "embedding.json"), "utf8")), {
        turns: [{ startMs: 0, endMs: 1_000, speaker: 0 }],
      });
      assert.equal(await fileExists(sliceFile(workspace.root, id, "0000.wav")), true);
      assert.equal(await fileExists(sliceFile(workspace.root, id, "0000.whistle.json")), true);
      const again = await reopened.start(wavPath);
      assert.deepEqual(again, { kind: "started", created: false, episode: expected });
    } finally {
      release();
      await queue.close();
      if (resumed !== undefined) {
        await resumed.close();
      }
      await workspace.cleanup();
    }
  });

  it("returns full when a failed transcript is started again and the queue is full", async () => {
    const workspace = await openWorkspace(1);
    let releaseHold = (): void => {};
    const holdGate = new Promise<void>((resolve) => {
      releaseHold = resolve;
    });
    let calls = 0;
    const whistle: WhistleCall = {
      async transcribeSlice(): Promise<WhistleResult> {
        calls += 1;
        if (calls === 1) {
          throw new Error("transcribe failed");
        }
        await holdGate;
        return hello();
      },
    };
    const queue = await openQueue(workspace, whistle);
    try {
      const failWav = join(workspace.audioDir, "fail.wav");
      const holdWav = join(workspace.audioDir, "hold.wav");
      await writeFile(failWav, pcmWav(1_000, 2));
      await writeFile(holdWav, pcmWav(1_000, 3));
      const failId = episodeIdFor(pcmWav(1_000, 2));
      const holdId = episodeIdFor(pcmWav(1_000, 3));
      const failedStart = await queue.start(failWav);
      assert.equal(failedStart.kind, "started");
      await waitFor(() => stateOf(queue.episode(failId), "transcript") === "failed");
      const failed = present(
        workspace,
        failId,
        1_000,
        { state: "failed", progress: 0, message: "transcribe failed" },
        WAITING,
      );
      assert.deepEqual(queue.episode(failId), failed);
      const held = await queue.start(holdWav);
      assert.equal(held.kind, "started");
      await waitFor(() => calls === 2);
      const retry = await queue.start(failWav);
      assert.deepEqual(retry, { kind: "full", queueLength: 1, unfinished: [holdId] });
      assert.deepEqual(queue.episode(failId), failed);
      assert.equal(calls, 2);
      const failedMessage = readMessage(
        JSON.parse(await readFile(transcriptFile(workspace.root, failId, "failed.json"), "utf8")),
      );
      assert.equal(failedMessage, "transcribe failed");
      assert.deepEqual(queue.episode("missing"), { state: "unknown", episodeId: "missing" });
      const oldStyle = `j${failId.slice(3)}`;
      assert.deepEqual(queue.episode(oldStyle), { state: "unknown", episodeId: oldStyle });
      assert.deepEqual(
        queue.episode(holdId),
        present(workspace, holdId, 1_000, { state: "running", progress: 0 }, WAITING),
      );

      releaseHold();
      await waitFor(() => bothReady(queue, holdId));
      const retried = await queue.start(failWav);
      assert.deepEqual(retried, {
        kind: "started",
        created: false,
        episode: present(workspace, failId, 1_000, { state: "running", progress: 0 }, WAITING),
      });
      await waitFor(() => bothReady(queue, failId));
      assert.equal(await fileExists(transcriptFile(workspace.root, failId, "failed.json")), false);
    } finally {
      releaseHold();
      await queue.close();
      await workspace.cleanup();
    }
  });

  it("counts Whistle files into progress and stops at 99 until the transcript is ready", async () => {
    const workspace = await openWorkspace(2);
    let calls = 0;
    const whistle: WhistleCall = {
      async transcribeSlice(): Promise<WhistleResult> {
        calls += 1;
        if (calls === 1) {
          return hello();
        }
        throw new Error("second slice failed");
      },
    };
    const queue = await openQueue(workspace, whistle);
    try {
      const bytes = pcmWav(28_001, 4);
      const id = episodeIdFor(bytes);
      await writeFile(join(workspace.audioDir, "two.wav"), bytes);
      const started = await queue.start(join(workspace.audioDir, "two.wav"));
      assert.equal(started.kind, "started");
      await waitFor(() => stateOf(queue.episode(id), "transcript") === "failed");
      assert.deepEqual(
        queue.episode(id),
        present(workspace, id, 28_001, { state: "failed", progress: 50, message: "second slice failed" }, WAITING),
      );
      assert.equal(await fileExists(sliceFile(workspace.root, id, "0000.whistle.json")), true);
      assert.equal(await fileExists(sliceFile(workspace.root, id, "0001.whistle.json")), false);
    } finally {
      await queue.close();
      await workspace.cleanup();
    }
  });

  it("reports progress 99 when the Whistle file is written and the VTT is not", async () => {
    const workspace = await openWorkspace(1);
    const whistle: WhistleCall = {
      async transcribeSlice(): Promise<WhistleResult> {
        return {
          kind: "speech",
          text: "x",
          language: "en",
          ttftMs: 1,
          decodeTps: 1,
          words: [{ word: "x", start: -1, end: 0.2, probability: 1 }],
        };
      },
    };
    const queue = await openQueue(workspace, whistle);
    try {
      const bytes = pcmWav(1_000, 5);
      const id = episodeIdFor(bytes);
      await writeFile(join(workspace.audioDir, "bad.wav"), bytes);
      const started = await queue.start(join(workspace.audioDir, "bad.wav"));
      assert.equal(started.kind, "started");
      await waitFor(() => stateOf(queue.episode(id), "transcript") === "failed");
      const failed = queue.episode(id);
      assert.deepEqual(
        failed,
        present(
          workspace,
          id,
          1_000,
          { state: "failed", progress: 99, message: "word time must be a non-negative finite second" },
          WAITING,
        ),
      );
      assert.equal(JSON.stringify(failed).includes("wavPath"), false);
      assert.equal(await fileExists(sliceFile(workspace.root, id, "0000.whistle.json")), true);
      assert.equal(await fileExists(transcriptFile(workspace.root, id, "transcript.vtt")), false);
    } finally {
      await queue.close();
      await workspace.cleanup();
    }
  });
});

describe("JobQueue lanes", () => {
  it("keeps at most whistleLimit slices in flight and counts completions out of order", async () => {
    const reference = await referenceVtt(FOUR_SLICES_MS, 6);
    const workspace = await openWorkspace(2, 3);
    const fake = gated();
    const queue = await openQueue(workspace, fake.whistle);
    try {
      const bytes = pcmWav(FOUR_SLICES_MS, 6);
      const id = episodeIdFor(bytes);
      await writeFile(join(workspace.audioDir, "four.wav"), bytes);
      await queue.start(join(workspace.audioDir, "four.wav"));
      await waitFor(() => fake.gates.size === 3);
      await delay(50);
      assert.deepEqual([...fake.gates.keys()].sort(), [0, 1, 2]);
      assert.equal(fake.peak(), 3);
      assert.deepEqual(
        queue.episode(id),
        present(workspace, id, FOUR_SLICES_MS, { state: "running", progress: 0 }, WAITING),
      );

      gate(fake.gates, 2).resolve(spoken(2));
      await waitFor(() => progressOf(queue.episode(id), "transcript") === 25);
      assert.equal(await fileExists(sliceFile(workspace.root, id, "0002.whistle.json")), true);
      assert.equal(await fileExists(sliceFile(workspace.root, id, "0000.whistle.json")), false);
      await waitFor(() => fake.gates.has(3));
      assert.equal(fake.peak(), 3);

      for (const index of [3, 1, 0]) {
        gate(fake.gates, index).resolve(spoken(index));
      }
      await waitFor(() => bothReady(queue, id));
      assert.deepEqual(
        queue.episode(id),
        present(workspace, id, FOUR_SLICES_MS, transcriptReady(workspace, id), embeddingReady(workspace, id)),
      );
      assert.equal(
        reference.toString("utf8"),
        [
          "WEBVTT",
          "",
          "c0001",
          "00:00:00.100 --> 00:00:00.400",
          "slice0.",
          "",
          "c0002",
          "00:00:27.100 --> 00:00:27.400",
          "slice1.",
          "",
          "c0003",
          "00:00:54.100 --> 00:00:54.400",
          "slice2.",
          "",
          "c0004",
          "00:01:21.100 --> 00:01:21.400",
          "slice3.",
          "",
        ].join("\n"),
      );
      assert.deepEqual(await readFile(transcriptFile(workspace.root, id, "transcript.vtt")), reference);
    } finally {
      await queue.close();
      await workspace.cleanup();
    }
  });

  it("stops taking slices after a failure and lets in-flight slices commit before marking failed", async () => {
    const workspace = await openWorkspace(2, 2);
    const fake = gated();
    const queue = await openQueue(workspace, fake.whistle);
    try {
      const bytes = pcmWav(FOUR_SLICES_MS, 7);
      const id = episodeIdFor(bytes);
      await writeFile(join(workspace.audioDir, "four.wav"), bytes);
      await queue.start(join(workspace.audioDir, "four.wav"));
      await waitFor(() => fake.gates.size === 2);

      gate(fake.gates, 1).reject(new Error("second slice failed"));
      await waitFor(() => fake.settled.includes(1));
      await delay(50);
      assert.deepEqual(
        queue.episode(id),
        present(workspace, id, FOUR_SLICES_MS, { state: "running", progress: 0 }, WAITING),
      );
      assert.equal(await fileExists(transcriptFile(workspace.root, id, "failed.json")), false);

      gate(fake.gates, 0).resolve(spoken(0));
      await waitFor(() => stateOf(queue.episode(id), "transcript") === "failed");
      assert.deepEqual(
        queue.episode(id),
        present(
          workspace,
          id,
          FOUR_SLICES_MS,
          { state: "failed", progress: 25, message: "second slice failed" },
          WAITING,
        ),
      );
      assert.deepEqual([...fake.gates.keys()].sort(), [0, 1]);
      assert.deepEqual(await sliceNames(workspace.root, id), ["0000.wav", "0000.whistle.json", "0001.wav"]);
    } finally {
      await queue.close();
      await workspace.cleanup();
    }
  });
});

describe("JobQueue resume", () => {
  it("transcribes a cut wav that has no Whistle JSON without cutting it again", async () => {
    const workspace = await openWorkspace(2);
    const { episodeId, vtt } = await completeAtLimitOne(workspace, FOUR_SLICES_MS, 8);
    await rm(sliceFile(workspace.root, episodeId, "0001.whistle.json"));
    await rm(transcriptFile(workspace.root, episodeId, "transcript.vtt"));
    const marker = Buffer.from("cut before the crash");
    await writeFile(sliceFile(workspace.root, episodeId, "0001.wav"), marker);
    const resumed = recorder();
    const queue = await openQueue(workspace, resumed.whistle, instantEmbed, { ...workspace.config, fleetLimit: 2 });
    try {
      await waitFor(() => stateOf(queue.episode(episodeId), "transcript") === "ready");
      assert.deepEqual(resumed.calls, [1]);
      assert.deepEqual(resumed.wavs.get(1), marker);
      assert.deepEqual(await readFile(transcriptFile(workspace.root, episodeId, "transcript.vtt")), vtt);
    } finally {
      await queue.close();
      await workspace.cleanup();
    }
  });

  it("sweeps leftover temp files and cuts again a slice whose wav never committed", async () => {
    const workspace = await openWorkspace(2);
    const { episodeId, vtt } = await completeAtLimitOne(workspace, FOUR_SLICES_MS, 9);
    await rm(sliceFile(workspace.root, episodeId, "0002.whistle.json"));
    await rm(sliceFile(workspace.root, episodeId, "0003.whistle.json"));
    await rm(sliceFile(workspace.root, episodeId, "0003.wav"));
    await rm(transcriptFile(workspace.root, episodeId, "transcript.vtt"));
    await writeFile(sliceFile(workspace.root, episodeId, "0002.whistle.json.0badf00d.tmp"), "{");
    await writeFile(sliceFile(workspace.root, episodeId, "0003.wav.0badf00d.tmp"), "partial");
    await writeFile(transcriptFile(workspace.root, episodeId, "transcript.vtt.0badf00d.tmp"), "WEBVTT\n");
    await writeFile(embeddingFile(workspace.root, episodeId, "embedding.json.0badf00d.tmp"), "{");
    const resumed = recorder();
    const queue = await openQueue(workspace, resumed.whistle, instantEmbed, { ...workspace.config, fleetLimit: 2 });
    try {
      await waitFor(() => bothReady(queue, episodeId));
      assert.deepEqual([...resumed.calls].sort(), [2, 3]);
      assert.deepEqual(await sliceNames(workspace.root, episodeId), ALL_SLICE_FILES);
      assert.deepEqual((await readdir(episodeDir(workspace.root, episodeId))).sort(), [
        "embedding",
        "episode.json",
        "groups.json",
        "source.wav",
        "transcript",
      ]);
      assert.deepEqual((await readdir(join(episodeDir(workspace.root, episodeId), "transcript"))).sort(), [
        "transcript.vtt",
        "turns.json",
        "work",
      ]);
      assert.deepEqual((await readdir(join(episodeDir(workspace.root, episodeId), "embedding"))).sort(), [
        "embedding.json",
      ]);
      assert.deepEqual(await readFile(transcriptFile(workspace.root, episodeId, "transcript.vtt")), vtt);
    } finally {
      await queue.close();
      await workspace.cleanup();
    }
  });

  it("transcribes only slices without Whistle JSON and starts progress from the committed ones", async () => {
    const workspace = await openWorkspace(2);
    const { episodeId, vtt } = await completeAtLimitOne(workspace, FOUR_SLICES_MS, 10);
    for (const name of ["0002.wav", "0002.whistle.json", "0003.wav", "0003.whistle.json"]) {
      await rm(sliceFile(workspace.root, episodeId, name));
    }
    await rm(transcriptFile(workspace.root, episodeId, "transcript.vtt"));
    await rm(embeddingFile(workspace.root, episodeId, "embedding.json"));
    const fake = gated();
    const queue = await openQueue(workspace, fake.whistle, instantEmbed, { ...workspace.config, fleetLimit: 2 });
    try {
      await waitFor(() => fake.gates.size === 2);
      assert.deepEqual([...fake.gates.keys()].sort(), [2, 3]);
      assert.deepEqual(
        queue.episode(episodeId),
        present(workspace, episodeId, FOUR_SLICES_MS, { state: "running", progress: 50 }, WAITING),
      );
      gate(fake.gates, 3).resolve(spoken(3));
      gate(fake.gates, 2).resolve(spoken(2));
      await waitFor(() => bothReady(queue, episodeId));
      assert.deepEqual(await readFile(transcriptFile(workspace.root, episodeId, "transcript.vtt")), vtt);
    } finally {
      await queue.close();
      await workspace.cleanup();
    }
  });

  it("rebuilds a missing transcript.vtt without calling Whistle", async () => {
    const workspace = await openWorkspace(2);
    const { episodeId, vtt } = await completeAtLimitOne(workspace, FOUR_SLICES_MS, 11);
    await rm(transcriptFile(workspace.root, episodeId, "transcript.vtt"));
    const resumed = recorder();
    const queue = await openQueue(workspace, resumed.whistle, instantEmbed, { ...workspace.config, fleetLimit: 3 });
    try {
      await waitFor(() => stateOf(queue.episode(episodeId), "transcript") === "ready");
      assert.deepEqual(resumed.calls, []);
      assert.deepEqual(await readFile(transcriptFile(workspace.root, episodeId, "transcript.vtt")), vtt);
    } finally {
      await queue.close();
      await workspace.cleanup();
    }
  });

  it("commits nothing from calls that finish after close, and the next open finishes the rest", async () => {
    const reference = await referenceVtt(FOUR_SLICES_MS, 12);
    const workspace = await openWorkspace(2, 3);
    const fake = gated();
    const queue = await openQueue(workspace, fake.whistle);
    let resumed: JobQueue | undefined;
    try {
      const bytes = pcmWav(FOUR_SLICES_MS, 12);
      const id = episodeIdFor(bytes);
      await writeFile(join(workspace.audioDir, "four.wav"), bytes);
      await queue.start(join(workspace.audioDir, "four.wav"));
      await waitFor(() => fake.gates.size === 3);
      gate(fake.gates, 1).resolve(spoken(1));
      await waitFor(() => fake.gates.has(3));
      assert.equal(await fileExists(sliceFile(workspace.root, id, "0001.whistle.json")), true);

      await queue.close();
      gate(fake.gates, 0).resolve(spoken(0));
      gate(fake.gates, 2).reject(new Error("worker pipe closed"));
      gate(fake.gates, 3).resolve(spoken(3));
      await waitFor(() => [0, 2, 3].every((index) => fake.settled.includes(index)));
      await delay(50);
      assert.deepEqual(await sliceNames(workspace.root, id), [
        "0000.wav",
        "0001.wav",
        "0001.whistle.json",
        "0002.wav",
        "0003.wav",
      ]);
      assert.equal(await fileExists(transcriptFile(workspace.root, id, "failed.json")), false);
      assert.equal(await fileExists(transcriptFile(workspace.root, id, "transcript.vtt")), false);

      const finishing = recorder();
      const reopened = await openQueue(workspace, finishing.whistle);
      resumed = reopened;
      await waitFor(() => bothReady(reopened, id));
      assert.deepEqual([...finishing.calls].sort(), [0, 2, 3]);
      assert.deepEqual(await readFile(transcriptFile(workspace.root, id, "transcript.vtt")), reference);
    } finally {
      await queue.close();
      if (resumed !== undefined) {
        await resumed.close();
      }
      await workspace.cleanup();
    }
  });
});

describe("JobQueue embedding", () => {
  it("copies the covering turn and names the cue group from its first cue", async () => {
    const workspace = await openWorkspace(2);
    const queue = await openQueue(workspace, { transcribeSlice: async () => cues([0]) });
    try {
      const bytes = pcmWav(6_000, 20);
      const id = episodeIdFor(bytes);
      await writeFile(join(workspace.audioDir, "talk.wav"), bytes);
      await queue.start(join(workspace.audioDir, "talk.wav"));
      await waitFor(() => bothReady(queue, id));
      assert.deepEqual(JSON.parse(await readFile(embeddingFile(workspace.root, id, "embedding.json"), "utf8")), {
        turns: [{ startMs: 0, endMs: 6_000, speaker: 0 }],
      });
      assert.deepEqual(JSON.parse(await readFile(join(episodeDir(workspace.root, id), "groups.json"), "utf8")), {
        cues: [{ id: "c0001", groupId: "gc0001", nearestGroupId: null, nearestCosine: null }],
      });
    } finally {
      await queue.close();
      await workspace.cleanup();
    }
  });

  it("reuses a valid turns file when the transcript is started again", async () => {
    const workspace = await openWorkspace(1);
    let diarized = 0;
    const diarize: DiarizeCall = {
      async prepare(): Promise<void> {},
      async diarize(sourcePath: string) {
        diarized += 1;
        const durationMs = await probeDurationMs(sourcePath);
        if (durationMs === undefined || durationMs < 1) {
          throw new Error("diarize fixture has no audio");
        }
        return {
          turns: [{ startMs: 0, endMs: durationMs, speaker: 0 }],
          centroids: [vector(1)],
        };
      },
    };
    let calls = 0;
    const whistle: WhistleCall = {
      async transcribeSlice(): Promise<WhistleResult> {
        calls += 1;
        if (calls === 1) {
          throw new Error("transcribe failed");
        }
        return hello();
      },
    };
    const queue = await openQueue(workspace, whistle, instantEmbed, workspace.config, diarize);
    try {
      const bytes = pcmWav(1_000, 21);
      const id = episodeIdFor(bytes);
      const wavPath = join(workspace.audioDir, "talk.wav");
      await writeFile(wavPath, bytes);
      await queue.start(wavPath);
      await waitFor(() => stateOf(queue.episode(id), "transcript") === "failed");
      assert.equal(diarized, 1);
      assert.equal(calls, 1);
      const again = await queue.start(wavPath);
      assert.equal(again.kind, "started");
      await waitFor(() => bothReady(queue, id));
      assert.equal(diarized, 1);
      assert.equal(calls, 2);
      assert.deepEqual(JSON.parse(await readFile(embeddingFile(workspace.root, id, "embedding.json"), "utf8")), {
        turns: [{ startMs: 0, endMs: 1_000, speaker: 0 }],
      });
    } finally {
      await queue.close();
      await workspace.cleanup();
    }
  });

  it("fails the transcript when diarize weights are missing and does not transcribe", async () => {
    const workspace = await openWorkspace(1);
    const ecapa = join(workspace.dir, "missing", "voxceleb_ECAPA512.onnx");
    const segmentation = join(workspace.dir, "missing", "segmentation.onnx");
    const host = openDiarizeHost(ecapa, segmentation);
    let calls = 0;
    const whistle: WhistleCall = {
      async transcribeSlice(): Promise<WhistleResult> {
        calls += 1;
        return hello();
      },
    };
    const queue = await openQueue(workspace, whistle, instantEmbed, workspace.config, host);
    try {
      const bytes = pcmWav(1_000, 22);
      const id = episodeIdFor(bytes);
      await writeFile(join(workspace.audioDir, "talk.wav"), bytes);
      await queue.start(join(workspace.audioDir, "talk.wav"));
      await waitFor(() => stateOf(queue.episode(id), "transcript") === "failed");
      const failed = queue.episode(id);
      const transcript = failed.state === "present" ? failed.artifacts[0] : undefined;
      if (transcript === undefined || transcript.state !== "failed") {
        throw new Error(JSON.stringify(failed));
      }
      assert.equal(transcript.message.includes("poddrill fetch-weights"), true);
      assert.equal(transcript.message.includes(ecapa), true);
      assert.equal(calls, 0);
      assert.equal(await fileExists(transcriptFile(workspace.root, id, "turns.json")), false);
      assert.equal(stateOf(queue.episode(id), "embedding"), "waiting");
    } finally {
      await queue.close();
      await host.close();
      await workspace.cleanup();
    }
  });

  it("counts only transcripts against queueLength", async () => {
    const workspace = await openWorkspace(1);
    let releaseHold = (): void => {};
    const holdGate = new Promise<void>((resolve) => {
      releaseHold = resolve;
    });
    let calls = 0;
    const whistle: WhistleCall = {
      async transcribeSlice(): Promise<WhistleResult> {
        calls += 1;
        if (calls > 1) {
          await holdGate;
        }
        return cues([0]);
      },
    };
    const queue = await openQueue(workspace, whistle);
    try {
      const firstBytes = pcmWav(6_000, 24);
      const firstId = episodeIdFor(firstBytes);
      await writeFile(join(workspace.audioDir, "first.wav"), firstBytes);
      await queue.start(join(workspace.audioDir, "first.wav"));
      await waitFor(() => bothReady(queue, firstId));
      assert.equal(queue.idle("transcript"), true);
      assert.equal(queue.idle("embedding"), true);

      const secondBytes = pcmWav(6_000, 25);
      const secondId = episodeIdFor(secondBytes);
      await writeFile(join(workspace.audioDir, "second.wav"), secondBytes);
      const second = await queue.start(join(workspace.audioDir, "second.wav"));
      assert.equal(second.kind, "started");
      await waitFor(() => calls === 2);

      await writeFile(join(workspace.audioDir, "third.wav"), pcmWav(6_000, 26));
      const third = await queue.start(join(workspace.audioDir, "third.wav"));
      assert.deepEqual(third, { kind: "full", queueLength: 1, unfinished: [secondId] });
      assert.equal(stateOf(queue.episode(firstId), "embedding"), "ready");
      assert.equal(stateOf(queue.episode(secondId), "transcript"), "running");
    } finally {
      releaseHold();
      await queue.close();
      await workspace.cleanup();
    }
  });
});

describe("model fleet config", () => {
  it("loads an old whistleLimit as the default fleet size", async () => {
    const workspace = await openWorkspace(1);
    try {
      const path = workspaceDirs(workspace.root).config;
      await writeFile(
        path,
        `${JSON.stringify({ provider: "localhost", queueLength: 1, whistleLimit: 3 }, null, 2)}\n`,
      );
      const config = await readConfig(workspace.root);
      assert.equal(config.fleetLimit, 3);
      assert.equal(fleetSize("whistle", config), 3);
      assert.equal(fleetSize("moonshine-tiny-ja", config), 3);
      assert.equal(
        fleetSize("moonshine-tiny-ja", { fleetLimit: 3, modelFleet: { "moonshine-tiny-ja": 4 } }),
        4,
      );
    } finally {
      await workspace.cleanup();
    }
  });

  it("rejects an unknown modelFleet id", async () => {
    const workspace = await openWorkspace(1);
    try {
      await writeFile(
        workspaceDirs(workspace.root).config,
        `${JSON.stringify({
          provider: "localhost",
          queueLength: 1,
          fleetLimit: 1,
          embeddingLimit: 1,
          modelFleet: { "not-a-model": 1 },
        })}\n`,
      );
      await assert.rejects(() => readConfig(workspace.root), /not-a-model/);
    } finally {
      await workspace.cleanup();
    }
  });

  it("rejects a relative model weights path", async () => {
    const workspace = await openWorkspace(1);
    try {
      await writeFile(
        workspaceDirs(workspace.root).config,
        `${JSON.stringify({
          provider: "localhost",
          queueLength: 1,
          fleetLimit: 1,
          embeddingLimit: 1,
          modelWeights: { whistle: "weights/whistle" },
        })}\n`,
      );
      await assert.rejects(() => readConfig(workspace.root), /absolute/);
    } finally {
      await workspace.cleanup();
    }
  });

  it("resolves ja to moonshine-tiny-ja", () => {
    const row = modelForLanguage("ja");
    if (row === undefined || row.engine !== "moonshine") {
      assert.fail("ja has no moonshine row");
    }
    assert.equal(row.id, "moonshine-tiny-ja");
    assert.equal(row.arch, "tiny");
    assert.equal(row.language, "ja");
  });

  it("refuses a model fleet change while the owner is alive and keeps a same config", async () => {
    const workspace = await openWorkspace(1);
    try {
      const path = workspaceDirs(workspace.root).config;
      const before = await readFile(path);
      const rejected = await setupWorkspace({
        root: workspace.dir,
        provider: "localhost",
        queueLength: 1,
        modelFleet: { "moonshine-tiny-ja": 4 },
        ownerAlive: true,
      });
      assert.equal(rejected.kind, "rejected");
      assert.deepEqual(await readFile(path), before);
      const same = await setupWorkspace({
        root: workspace.dir,
        provider: "localhost",
        queueLength: 1,
        fleetLimit: 1,
        embeddingLimit: 1,
        ownerAlive: true,
      });
      assert.equal(same.kind, "ready");
      assert.deepEqual(await readFile(path), before);
    } finally {
      await workspace.cleanup();
    }
  });
});

describe("episode language", () => {
  it("rejects an unknown language and writes no episode directory", async () => {
    const workspace = await openWorkspace(1);
    const queue = await openQueue(workspace, { transcribeSlice: async () => hello() });
    try {
      const wavPath = join(workspace.audioDir, "xx.wav");
      await writeFile(wavPath, pcmWav(1_000, 4));
      const episodes = workspaceDirs(workspace.root).episodesDir;
      const rejected = await queue.start(wavPath, "xx");
      assert.deepEqual(rejected, {
        kind: "rejected",
        reason: "unknown-language",
        message: "unknown language xx",
      });
      assert.deepEqual(await readdir(episodes), []);
    } finally {
      await queue.close();
      await workspace.cleanup();
    }
  });

  it("keeps the stored language when the same audio starts again", async () => {
    const workspace = await openWorkspace(1);
    const queue = await openQueue(workspace, { transcribeSlice: async () => hello() });
    try {
      const bytes = pcmWav(1_000, 5);
      const wavPath = join(workspace.audioDir, "keep.wav");
      await writeFile(wavPath, bytes);
      const started = await queue.start(wavPath);
      assert.equal(started.kind, "started");
      if (started.kind !== "started") {
        return;
      }
      assert.equal(started.episode.language, "en");
      const again = await queue.start(wavPath, "de");
      assert.equal(again.kind, "started");
      if (again.kind !== "started") {
        return;
      }
      assert.equal(again.created, false);
      assert.equal(again.episode.language, "en");
      const manifest = objectRecord(
        JSON.parse(await readFile(join(episodeDir(workspace.root, started.episode.episodeId), "episode.json"), "utf8")),
      );
      assert.equal(manifest["language"], "en");
    } finally {
      await queue.close();
      await workspace.cleanup();
    }
  });

  it("reads an episode file with no language field as en", async () => {
    const workspace = await openWorkspace(1);
    const queue = await openQueue(workspace, { transcribeSlice: async () => hello() });
    try {
      const bytes = pcmWav(1_000, 6);
      const wavPath = join(workspace.audioDir, "old.wav");
      await writeFile(wavPath, bytes);
      const started = await queue.start(wavPath);
      assert.equal(started.kind, "started");
      if (started.kind !== "started") {
        return;
      }
      const id = started.episode.episodeId;
      await waitFor(() => bothReady(queue, id));
      await queue.close();
      const manifestPath = join(episodeDir(workspace.root, id), "episode.json");
      const manifest = objectRecord(JSON.parse(await readFile(manifestPath, "utf8")));
      delete manifest["language"];
      await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
      const reopened = await openQueue(workspace, { transcribeSlice: async () => hello() });
      try {
        assert.deepEqual(reopened.episode(id), {
          ...present(workspace, id, 1_000, transcriptReady(workspace, id), embeddingReady(workspace, id)),
          language: "en",
        });
      } finally {
        await reopened.close();
      }
    } finally {
      await queue.close();
      await workspace.cleanup();
    }
  });

  it("fails a Japanese transcript when moonshine weights are missing and downloads nothing", async () => {
    const workspace = await openWorkspace(1);
    let calls = 0;
    const queue = await openQueue(workspace, {
      async transcribeSlice(): Promise<WhistleResult> {
        calls += 1;
        return hello();
      },
    });
    try {
      const bytes = pcmWav(1_000, 7);
      const wavPath = join(workspace.audioDir, "ja.wav");
      await writeFile(wavPath, bytes);
      const started = await queue.start(wavPath, "ja");
      assert.equal(started.kind, "started");
      if (started.kind !== "started") {
        return;
      }
      assert.equal(started.episode.language, "ja");
      const id = started.episode.episodeId;
      await waitFor(() => stateOf(queue.episode(id), "transcript") === "failed");
      assert.deepEqual(artifactOf(queue.episode(id), "transcript"), {
        artifact: "transcript",
        state: "failed",
        progress: 0,
        message: "moonshine-tiny-ja has no weights path",
      });
      assert.equal(calls, 0);
      const names = (await readdir(workspace.dir, { recursive: true })).map((name) => String(name));
      assert.deepEqual(
        names.filter((name) => name.includes("moonshine") || name.endsWith(".onnx") || name.endsWith(".bin")),
        [],
      );
    } finally {
      await queue.close();
      await workspace.cleanup();
    }
  });

  it("runs a Japanese transcript through its worker when a weights path is set", async () => {
    const workspace = await openWorkspace(1);
    const weights = join(workspace.dir, "moonshine-tiny-ja");
    let calls = 0;
    const queue = await openQueue(
      workspace,
      {
        async transcribeSlice(): Promise<WhistleResult> {
          calls += 1;
          throw new Error("weights did not load");
        },
      },
      instantEmbed,
      { ...workspace.config, modelWeights: { "moonshine-tiny-ja": weights } },
    );
    try {
      const wavPath = join(workspace.audioDir, "ja-wired.wav");
      await writeFile(wavPath, pcmWav(1_000, 8));
      const started = await queue.start(wavPath, "ja");
      assert.equal(started.kind, "started");
      if (started.kind !== "started") {
        return;
      }
      const id = started.episode.episodeId;
      await waitFor(() => stateOf(queue.episode(id), "transcript") === "failed");
      assert.equal(calls, 1);
      assert.deepEqual(artifactOf(queue.episode(id), "transcript"), {
        artifact: "transcript",
        state: "failed",
        progress: 0,
        message: "weights did not load",
      });
      assert.equal(await fileExists(weights), false);
    } finally {
      await queue.close();
      await workspace.cleanup();
    }
  });

  it("turns one Moonshine word into one cue", () => {
    const slice = planSlices(1_000)[0];
    if (slice === undefined) {
      throw new Error("expected one slice");
    }
    const whistle = moonshineToWhistle(
      {
        lines: [
          {
            text: "こんにちは",
            start_time: 0.1,
            duration: 0.4,
            words: [{ word: "こんにちは", start: 0.2, end: 0.5, confidence: 0.8 }],
          },
        ],
      },
      "ja",
    );
    assert.deepEqual(projectSlices([{ plan: slice, slicePath: "/ja.wav", whistle }]).cues, [
      {
        id: "c0001",
        start: EpisodeTime.shift(0, 0.2),
        end: EpisodeTime.shift(0, 0.5),
        text: "こんにちは",
        pieces: [{ sliceIndex: 0, wordIndex: 0 }],
      },
    ]);
  });

  it("turns a line with no words into one covering cue", () => {
    const slice = planSlices(1_000)[0];
    if (slice === undefined) {
      throw new Error("expected one slice");
    }
    const whistle = moonshineToWhistle(
      {
        lines: [{ text: "こんにちは。", start_time: 0.1, duration: 1.2, words: [] }],
      },
      "ja",
    );
    assert.deepEqual(projectSlices([{ plan: slice, slicePath: "/ja.wav", whistle }]).cues, [
      {
        id: "c0001",
        start: EpisodeTime.shift(0, 0.1),
        end: EpisodeTime.shift(0, 1.3),
        text: "こんにちは。",
        pieces: [{ sliceIndex: 0, wordIndex: 0 }],
      },
    ]);
  });

  it("reports a missing moonshine_voice module as a PodDrill Python install", async () => {
    const workspace = await openWorkspace(1);
    const weights = join(workspace.dir, "moonshine-tiny-ja");
    const host = openWhistleCall(
      "localhost",
      {
        fleetLimit: workspace.config.fleetLimit,
        modelFleet: workspace.config.modelFleet,
        modelWeights: { "moonshine-tiny-ja": weights },
      },
      spawnNeedleWorker,
      () => (events) => {
        setImmediate(() => {
          events.ready();
        });
        return {
          request: () =>
            Promise.reject(new Error("ModuleNotFoundError: No module named 'moonshine_voice'")),
          close: () => {},
        };
      },
    );
    const queue = await openQueue(workspace, host, instantEmbed, {
      ...workspace.config,
      modelWeights: { "moonshine-tiny-ja": weights },
    });
    try {
      const wavPath = join(workspace.audioDir, "ja-missing.wav");
      await writeFile(wavPath, pcmWav(1_000, 9));
      const started = await queue.start(wavPath, "ja");
      assert.equal(started.kind, "started");
      if (started.kind !== "started") {
        return;
      }
      const id = started.episode.episodeId;
      await waitFor(() => stateOf(queue.episode(id), "transcript") === "failed");
      assert.deepEqual(artifactOf(queue.episode(id), "transcript"), {
        artifact: "transcript",
        state: "failed",
        progress: 0,
        message: "Install moonshine-voice into the PodDrill Python: \"$PODDRILL_PYTHON\" -m pip install moonshine-voice",
      });
      assert.equal(await fileExists(weights), false);
    } finally {
      await queue.close();
      await host.close();
      await workspace.cleanup();
    }
  });
});

function objectRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("episode.json is not an object");
  }
  const record: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    record[key] = item;
  }
  return record;
}
