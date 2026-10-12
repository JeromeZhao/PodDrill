/**
 * Audio duration and slicing. Host-independent. No provider imports.
 * 16-bit PCM mono 16 kHz WAV is copied sample for sample. Every other input is transcoded with ffmpeg.
 */

import { spawn } from "node:child_process";
import { open, writeFile, type FileHandle } from "node:fs/promises";

import { SLICE_MS, type PlannedSlice } from "./episode.ts";

/** A slice or a stretch. Never longer than `SLICE_MS`. */
export type CutSpan = Pick<PlannedSlice, "index" | "startMs" | "endMs">;

/** Whistle's input rate. The copy path cannot resample. */
const SAMPLE_RATE = 16_000;
const SAMPLES_PER_MS = SAMPLE_RATE / 1000;
const BYTES_PER_SAMPLE = 2;
const PCM_FORMAT = 1;

interface PcmData {
  readonly dataOffset: number;
  readonly sampleCount: number;
}

/** Integer milliseconds, or `undefined` when the file has no decodable audio. */
export async function probeDurationMs(path: string): Promise<number | undefined> {
  const handle = await open(path, "r");
  try {
    const pcm = await readPcmData(handle, path);
    return pcm === undefined ? undefined : Math.floor((pcm.sampleCount * 1000) / SAMPLE_RATE);
  } catch (error: unknown) {
    if (!isFormatGap(error)) {
      throw error;
    }
  } finally {
    await handle.close();
  }
  return durationMsFromBanner(await ffmpegBanner(path));
}

function durationMsFromBanner(report: string): number | undefined {
  const match = /Duration:\s*(\d+):(\d{2}):(\d{2}(?:\.\d+)?)/.exec(report);
  if (match === null) {
    return undefined;
  }
  const hours = match[1];
  const minutes = match[2];
  const seconds = match[3];
  if (hours === undefined || minutes === undefined || seconds === undefined) {
    return undefined;
  }
  const total = Number(hours) * 3600 + Number(minutes) * 60 + Number(seconds);
  if (!Number.isFinite(total)) {
    return undefined;
  }
  return Math.floor(total * 1000);
}

function ffmpegBanner(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error: Error | undefined, report: string): void => {
      if (settled) {
        return;
      }
      settled = true;
      if (error !== undefined) {
        reject(error);
        return;
      }
      resolve(report);
    };
    const child = spawn("ffmpeg", ["-hide_banner", "-nostdin", "-i", path], {
      stdio: ["ignore", "ignore", "pipe"],
    });
    const stderr: Buffer[] = [];
    const stderrStream = child.stderr;
    if (stderrStream !== null) {
      stderrStream.on("data", (chunk: Buffer) => {
        stderr.push(chunk);
      });
    }
    child.on("error", (error: Error) => {
      if (spawnCode(error) === "ENOENT") {
        finish(new Error("ffmpeg is not installed"), "");
        return;
      }
      finish(error, "");
    });
    // ffmpeg -i exits 1 after it prints Duration. The banner is the result.
    child.on("close", () => {
      finish(undefined, Buffer.concat(stderr).toString("utf8"));
    });
  });
}

/** Write `slice.startMs`..`slice.endMs` of `source` to `outPath` as 16 kHz mono WAV. */
export async function cutSlice(source: string, slice: CutSpan, outPath: string): Promise<void> {
  try {
    await copyPcmSlice(source, slice, outPath);
  } catch (error: unknown) {
    if (!isFormatGap(error)) {
      throw error;
    }
    await transcodeSlice(source, slice, outPath);
  }
}

async function copyPcmSlice(source: string, slice: CutSpan, outPath: string): Promise<void> {
  const handle = await open(source, "r");
  try {
    const pcm = await readPcmData(handle, source);
    if (pcm === undefined) {
      throw new Error(`${source} has no PCM data`);
    }
    const first = slice.startMs * SAMPLES_PER_MS;
    const last = Math.min(slice.endMs * SAMPLES_PER_MS, pcm.sampleCount);
    if (first >= last) {
      throw new Error(`slice ${slice.index} starts past the end of ${source}`);
    }
    const samples = await readAt(
      handle,
      pcm.dataOffset + first * BYTES_PER_SAMPLE,
      (last - first) * BYTES_PER_SAMPLE,
    );
    await writeFile(outPath, Buffer.concat([wavHeader(samples.length), samples]));
  } finally {
    await handle.close();
  }
}

async function transcodeSlice(source: string, slice: CutSpan, outPath: string): Promise<void> {
  const spanMs = slice.endMs - slice.startMs;
  if (spanMs <= 0) {
    throw new Error(`slice ${slice.index} starts past the end of ${source}`);
  }
  const durationMs = Math.min(spanMs, SLICE_MS);
  await runFfmpeg([
    "-hide_banner",
    "-loglevel",
    "error",
    "-nostdin",
    "-y",
    "-ss",
    seconds(slice.startMs),
    "-t",
    seconds(durationMs),
    "-i",
    source,
    "-ac",
    "1",
    "-ar",
    String(SAMPLE_RATE),
    "-c:a",
    "pcm_s16le",
    // A .tmp suffix does not name a muxer.
    "-f",
    "wav",
    outPath,
  ]);
}

function seconds(milliseconds: number): string {
  return (milliseconds / 1000).toFixed(3);
}

function isFormatGap(error: unknown): boolean {
  return error instanceof Error && error.message.startsWith("audio format not implemented:");
}

function runFfmpeg(args: readonly string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error: Error | undefined): void => {
      if (settled) {
        return;
      }
      settled = true;
      if (error === undefined) {
        resolve();
        return;
      }
      reject(error);
    };
    const child = spawn("ffmpeg", [...args], { stdio: ["ignore", "ignore", "pipe"] });
    const stderr: Buffer[] = [];
    const stderrStream = child.stderr;
    if (stderrStream !== null) {
      stderrStream.on("data", (chunk: Buffer) => {
        stderr.push(chunk);
      });
    }
    child.on("error", (error: Error) => {
      if (spawnCode(error) === "ENOENT") {
        finish(new Error("ffmpeg is not installed"));
        return;
      }
      finish(error);
    });
    child.on("close", (code: number | null) => {
      if (code === 0) {
        finish(undefined);
        return;
      }
      const detail = Buffer.concat(stderr).toString("utf8").trim();
      const status = code === null ? "null" : String(code);
      finish(new Error(detail === "" ? `ffmpeg exited with code ${status}` : `ffmpeg: ${detail}`));
    });
  });
}

function spawnCode(error: Error): string | undefined {
  if (!("code" in error)) {
    return undefined;
  }
  const code = error.code;
  return typeof code === "string" ? code : undefined;
}

async function readPcmData(handle: FileHandle, path: string): Promise<PcmData | undefined> {
  const riff = await readAt(handle, 0, 12);
  if (
    riff.length < 12 ||
    riff.toString("ascii", 0, 4) !== "RIFF" ||
    riff.toString("ascii", 8, 12) !== "WAVE"
  ) {
    throw notImplemented(path, "is not a WAV file");
  }
  const { size } = await handle.stat();
  let supported = false;
  let offset = 12;
  while (offset + 8 <= size) {
    const chunk = await readAt(handle, offset, 8);
    const id = chunk.toString("ascii", 0, 4);
    const chunkSize = chunk.readUInt32LE(4);
    const body = offset + 8;
    if (id === "fmt ") {
      if (chunkSize < 16) {
        return undefined;
      }
      const fmt = await readAt(handle, body, 16);
      const format = fmt.readUInt16LE(0);
      const channels = fmt.readUInt16LE(2);
      const sampleRate = fmt.readUInt32LE(4);
      const bits = fmt.readUInt16LE(14);
      if (format !== PCM_FORMAT || channels !== 1 || sampleRate !== SAMPLE_RATE || bits !== 16) {
        throw notImplemented(
          path,
          `is format ${format}, ${channels} channels, ${sampleRate} Hz, ${bits}-bit`,
        );
      }
      supported = true;
    } else if (id === "data") {
      if (!supported) {
        return undefined;
      }
      const bytes = Math.min(chunkSize, size - body);
      return { dataOffset: body, sampleCount: Math.floor(bytes / BYTES_PER_SAMPLE) };
    }
    offset = body + chunkSize + (chunkSize % 2);
  }
  return undefined;
}

async function readAt(handle: FileHandle, position: number, length: number): Promise<Buffer> {
  const buffer = Buffer.alloc(length);
  const { bytesRead } = await handle.read(buffer, 0, length, position);
  return buffer.subarray(0, bytesRead);
}

function wavHeader(dataBytes: number): Buffer {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + dataBytes, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(PCM_FORMAT, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(SAMPLE_RATE, 24);
  header.writeUInt32LE(SAMPLE_RATE * BYTES_PER_SAMPLE, 28);
  header.writeUInt16LE(BYTES_PER_SAMPLE, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(dataBytes, 40);
  return header;
}

function notImplemented(path: string, detail: string): Error {
  return new Error(
    `audio format not implemented: ${path} ${detail}. Only 16-bit PCM mono 16 kHz WAV is supported.`,
  );
}
