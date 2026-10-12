import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, type TestContext } from "node:test";

import { cutSlice, probeDurationMs } from "../src/audio.ts";
import type { PlannedSlice } from "../src/episode.ts";

const SAMPLE_RATE = 16_000;

/** 80-bit sample rate for 16 kHz. ffmpeg's AIFF header uses these bytes. */
const AIFF_16K = Buffer.from("400cfa00000000000000", "hex");

function pcmWav(durationMs: number): Buffer {
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
  return buffer;
}

function oneSecondAiff(): Buffer {
  const sampleCount = 16_000;
  const dataBytes = sampleCount * 2;
  const commBody = 18;
  const ssndBody = 8 + dataBytes;
  const formBody = 4 + (8 + commBody) + (8 + ssndBody);
  const buffer = Buffer.alloc(8 + formBody);
  let offset = 0;
  const writeText = (text: string): void => {
    buffer.write(text, offset, "ascii");
    offset += 4;
  };
  const writeU32 = (value: number): void => {
    buffer.writeUInt32BE(value, offset);
    offset += 4;
  };
  const writeU16 = (value: number): void => {
    buffer.writeUInt16BE(value, offset);
    offset += 2;
  };
  writeText("FORM");
  writeU32(formBody);
  writeText("AIFF");
  writeText("COMM");
  writeU32(commBody);
  writeU16(1);
  writeU32(sampleCount);
  writeU16(16);
  AIFF_16K.copy(buffer, offset);
  offset += AIFF_16K.length;
  writeText("SSND");
  writeU32(ssndBody);
  writeU32(0);
  writeU32(0);
  return buffer;
}

function ffmpegOnPath(): boolean {
  const probed = spawnSync("ffmpeg", ["-version"], { stdio: "ignore" });
  return probed.status === 0;
}

function oneSecondSlice(): PlannedSlice {
  return {
    index: 0,
    startMs: 0,
    endMs: 1000,
    keepStartMs: 0,
    keepEndMs: 1000,
  };
}

// The absent-ffmpeg test replaces PATH. A duration probe in parallel would miss ffmpeg.
describe("audio", { concurrency: false }, () => {
  it("reports 1000 ms for a generated one-second 16 kHz wav", async () => {
    const dir = await mkdtemp(join(tmpdir(), "poddrill-audio-"));
    try {
      const path = join(dir, "one.wav");
      await writeFile(path, pcmWav(1000));
      assert.equal(await probeDurationMs(path), 1000);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("returns undefined for a text file and 1000 ms for a one-second AIFF", async () => {
    const dir = await mkdtemp(join(tmpdir(), "poddrill-audio-"));
    try {
      const notes = join(dir, "notes.txt");
      await writeFile(notes, "not audio\n");
      assert.equal(await probeDurationMs(notes), undefined);
      const aiff = join(dir, "one.aiff");
      await writeFile(aiff, oneSecondAiff());
      assert.equal(await probeDurationMs(aiff), 1000);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("writes RIFF when ffmpeg cuts a non-wav file to a .tmp path", async (t: TestContext) => {
    if (!ffmpegOnPath()) {
      t.skip("ffmpeg is not on PATH");
      return;
    }
    const dir = await mkdtemp(join(tmpdir(), "poddrill-audio-"));
    try {
      const source = join(dir, "one.aiff");
      await writeFile(source, oneSecondAiff());
      const outPath = join(dir, "0000.wav.b27487eb.tmp");
      await cutSlice(source, oneSecondSlice(), outPath);
      const bytes = await readFile(outPath);
      assert.equal(bytes.subarray(0, 4).toString("ascii"), "RIFF");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("names ffmpeg when a non-wav file is cut and ffmpeg is absent", async () => {
    const dir = await mkdtemp(join(tmpdir(), "poddrill-audio-"));
    const savedPath = process.env["PATH"];
    process.env["PATH"] = dir;
    try {
      const source = join(dir, "note.txt");
      await writeFile(source, "not audio");
      await assert.rejects(
        () => cutSlice(source, oneSecondSlice(), join(dir, "out.wav")),
        (error: unknown) => {
          assert.ok(error instanceof Error);
          assert.match(error.message, /ffmpeg/);
          return true;
        },
      );
    } finally {
      if (savedPath === undefined) {
        delete process.env["PATH"];
      } else {
        process.env["PATH"] = savedPath;
      }
      await rm(dir, { recursive: true, force: true });
    }
  });
});
