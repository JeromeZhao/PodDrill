/**
 * The local ECAPA embedding host. One python3 process per fleet slot, never shared with Whistle.
 * Ready frame: { "kind": "ready" }. Result: 192 numbers for one stretch wav.
 * Frontend: float samples times 32768, Kaldi fbank with 80 bins, hamming, 25 ms window, 10 ms shift,
 * dither 0, then CMN, then the ONNX session on CPU.
 */

import { homedir } from "node:os";
import { join } from "node:path";

import { pathExists } from "./disk.ts";
import { openFleet, type SpawnWorker } from "./fleet.ts";
import { PYTHON_FRAMES, spawnFramedWorker } from "./worker.ts";

export const EMBEDDING_SIZE = 192;

/** What the store sees. Callers may overlap calls. */
export interface EmbedCall {
  /**
   * Fail the stage before any stretch is cut when the weights file is absent.
   * Must not spawn a worker.
   */
  prepare(): Promise<void>;
  embedStretch(wavPath: string): Promise<readonly number[]>;
}

/** An `EmbedCall` plus its lifetime. Only the creator holds this type. */
export interface EmbedHost extends EmbedCall {
  close(): Promise<void>;
  /** Drop idle workers and leave the host open. False means nothing changed. */
  release(): boolean;
}

/** `PODDRILL_EMBED_WEIGHTS`, else `~/.cache/poddrill/ecapa/voxceleb_ECAPA512.onnx`. */
export function embedWeightsPath(env: Readonly<Record<string, string | undefined>>): string {
  const configured = env["PODDRILL_EMBED_WEIGHTS"];
  if (configured !== undefined && configured !== "") {
    return configured;
  }
  return join(homedir(), ".cache", "poddrill", "ecapa", "voxceleb_ECAPA512.onnx");
}

/** Spawns nothing until the first stretch. A missing weights file fails each call without spawning. */
export function openEmbedHost(embeddingLimit: number, weightsPath: string): EmbedHost {
  if (!Number.isInteger(embeddingLimit) || embeddingLimit < 1) {
    throw new Error(`embedding limit must be a positive integer, got ${embeddingLimit}`);
  }
  const pool = openFleet({
    limit: embeddingLimit,
    spawn: spawnEmbedWorker(weightsPath),
    closedMessage: "embedding host is closed",
  });
  const requireWeights = async (): Promise<void> => {
    if (!(await pathExists(weightsPath))) {
      throw new Error(
        `ECAPA weights are missing at ${weightsPath}. Put the file there or set PODDRILL_EMBED_WEIGHTS.`,
      );
    }
  };
  return {
    prepare: requireWeights,
    async embedStretch(wavPath: string): Promise<readonly number[]> {
      await requireWeights();
      return pool.run(wavPath);
    },
    close: () => pool.close(),
    release: () => pool.release(),
  };
}

function spawnEmbedWorker(weightsPath: string): SpawnWorker<readonly number[]> {
  return (events) => {
    const link = spawnFramedWorker(
      {
        label: "ecapa",
        args: ["-c", WORKER_SCRIPT, weightsPath],
        checkReady: async () => undefined,
        parseResult: parseEmbedding,
      },
      events,
    );
    return {
      request: (wavPath) => link.request({ wavPath }),
      close: () => link.close(),
    };
  };
}

function parseEmbedding(value: unknown): readonly number[] {
  if (!Array.isArray(value)) {
    throw new Error("ecapa result must be an array");
  }
  const vector: number[] = [];
  for (const item of value) {
    if (typeof item !== "number" || !Number.isFinite(item)) {
      throw new Error("ecapa result must hold finite numbers");
    }
    vector.push(item);
  }
  if (vector.length !== EMBEDDING_SIZE) {
    throw new Error(`ecapa result has ${vector.length} values, not ${EMBEDDING_SIZE}`);
  }
  return vector;
}

/** Mirrors torchaudio's `compliance.kaldi.fbank`, including DC removal and 0.97 preemphasis. */
const WORKER_SCRIPT = [
  PYTHON_FRAMES,
  "import wave",
  "import numpy as np",
  "import onnxruntime as ort",
  "session = ort.InferenceSession(sys.argv[1], providers=[\"CPUExecutionProvider\"])",
  "feed = session.get_inputs()[0].name",
  "RATE = 16000",
  "FRAME = 400",
  "SHIFT = 160",
  "FFT = 512",
  "BINS = 80",
  "EPS = float(np.finfo(np.float32).eps)",
  "def mel(freq):",
  "    return 1127.0 * np.log(1.0 + freq / 700.0)",
  "def mel_banks():",
  "    low = mel(20.0)",
  "    delta = (mel(RATE / 2.0) - low) / (BINS + 1)",
  "    bins = mel(np.arange(FFT // 2) * (RATE / FFT))[None, :]",
  "    left = low + np.arange(BINS)[:, None] * delta",
  "    center = left + delta",
  "    right = center + delta",
  "    banks = np.maximum(0.0, np.minimum((bins - left) / delta, (right - bins) / delta))",
  "    return np.pad(banks, ((0, 0), (0, 1)))",
  "BANKS = mel_banks()",
  "WINDOW = 0.54 - 0.46 * np.cos(2.0 * np.pi * np.arange(FRAME) / (FRAME - 1))",
  "def fbank(samples):",
  "    if len(samples) < FRAME:",
  "        raise ValueError(\"stretch is shorter than one 25 ms frame\")",
  "    count = 1 + (len(samples) - FRAME) // SHIFT",
  "    index = np.arange(FRAME)[None, :] + SHIFT * np.arange(count)[:, None]",
  "    frames = samples[index].astype(np.float64)",
  "    frames = frames - frames.mean(axis=1, keepdims=True)",
  "    frames = frames - 0.97 * np.concatenate([frames[:, :1], frames[:, :-1]], axis=1)",
  "    power = np.abs(np.fft.rfft(frames * WINDOW, n=FFT)) ** 2",
  "    return np.log(np.maximum(power @ BANKS.T, EPS))",
  "def read_wav(path):",
  "    with wave.open(path, \"rb\") as reader:",
  "        if reader.getnchannels() != 1 or reader.getsampwidth() != 2 or reader.getframerate() != RATE:",
  "            raise ValueError(path + \" is not 16-bit mono 16 kHz wav\")",
  "        pcm = reader.readframes(reader.getnframes())",
  "    return np.frombuffer(pcm, dtype=\"<i2\").astype(np.float64) / 32768.0",
  "def embed(message):",
  "    wav_path = message[\"wavPath\"]",
  "    feats = fbank(read_wav(wav_path) * 32768.0)",
  "    feats = feats - feats.mean(axis=0, keepdims=True)",
  "    output = session.run(None, {feed: feats[None, :, :].astype(np.float32)})[0]",
  "    return [float(value) for value in np.asarray(output).reshape(-1)]",
  "send({\"kind\": \"ready\"})",
  "serve(embed)",
].join("\n");
