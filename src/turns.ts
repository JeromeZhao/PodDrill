import { asRecord } from "./disk.ts";

export interface Turn {
  readonly startMs: number;
  readonly endMs: number;
  readonly speaker: number;
}

export interface SpeakerTracks {
  readonly turns: readonly Turn[];
  readonly centroids: readonly (readonly number[])[];
}

export function parseSpeakerTracks(value: unknown): SpeakerTracks | undefined {
  const record = asRecord(value);
  if (record === undefined || !Array.isArray(record["turns"]) || !Array.isArray(record["centroids"])) {
    return undefined;
  }
  const turns = parseTurns(record["turns"]);
  const centroids = parseCentroids(record["centroids"]);
  if (turns === undefined || centroids === undefined || !centroidsCover(turns, centroids)) {
    return undefined;
  }
  return { turns, centroids };
}

function parseTurns(value: readonly unknown[]): readonly Turn[] | undefined {
  const turns: Turn[] = [];
  let previousEnd = 0;
  for (const item of value) {
    const turn = parseTurn(item);
    if (turn === undefined || turn.startMs < previousEnd) {
      return undefined;
    }
    turns.push(turn);
    previousEnd = turn.endMs;
  }
  return turns;
}

function parseTurn(value: unknown): Turn | undefined {
  const record = asRecord(value);
  if (record === undefined) {
    return undefined;
  }
  const startMs = record["startMs"];
  const endMs = record["endMs"];
  const speaker = record["speaker"];
  if (!isWhole(startMs) || !isWhole(endMs) || !isWhole(speaker) || endMs <= startMs) {
    return undefined;
  }
  return { startMs, endMs, speaker };
}

function parseCentroids(value: readonly unknown[]): readonly (readonly number[])[] | undefined {
  const centroids: (readonly number[])[] = [];
  let width: number | undefined;
  for (const item of value) {
    const centroid = finiteVector(item);
    if (centroid === undefined) {
      return undefined;
    }
    if (width === undefined) {
      width = centroid.length;
    }
    if (centroid.length !== width) {
      return undefined;
    }
    centroids.push(centroid);
  }
  return centroids;
}

function centroidsCover(turns: readonly Turn[], centroids: readonly (readonly number[])[]): boolean {
  if (turns.length === 0) {
    return true;
  }
  let maxSpeaker = 0;
  for (const turn of turns) {
    if (turn.speaker > maxSpeaker) {
      maxSpeaker = turn.speaker;
    }
  }
  return centroids.length > maxSpeaker;
}

function finiteVector(value: unknown): readonly number[] | undefined {
  if (!Array.isArray(value) || value.length === 0) {
    return undefined;
  }
  const numbers: number[] = [];
  for (const item of value) {
    if (typeof item !== "number" || !Number.isFinite(item)) {
      return undefined;
    }
    numbers.push(item);
  }
  return numbers;
}

function isWhole(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}
