import { OVERLAP_MS, SLICE_MS, type PlannedSlice } from "./episode.ts";
import type { Turn } from "./turns.ts";

const JOIN_GAP_MS = 500;
const SHORT_TURN_MS = 500;
const STEP_MS = SLICE_MS - OVERLAP_MS;

interface Region {
  startMs: number;
  endMs: number;
}

export function planRegions(turns: readonly Turn[]): readonly PlannedSlice[] {
  const slices: PlannedSlice[] = [];
  for (const region of absorbShort(joinSameSpeaker(turns))) {
    appendSpan(slices, region.startMs, region.endMs);
  }
  return slices;
}

function joinSameSpeaker(turns: readonly Turn[]): readonly Region[] {
  const regions: Region[] = [];
  let speaker = -1;
  for (const turn of turns) {
    const last = regions[regions.length - 1];
    if (last !== undefined && turn.speaker === speaker && turn.startMs - last.endMs <= JOIN_GAP_MS) {
      last.endMs = turn.endMs;
      continue;
    }
    regions.push({ startMs: turn.startMs, endMs: turn.endMs });
    speaker = turn.speaker;
  }
  return regions;
}

function absorbShort(regions: readonly Region[]): readonly Region[] {
  const pending = regions.map((region) => ({ startMs: region.startMs, endMs: region.endMs }));
  const kept: Region[] = [];
  for (let index = 0; index < pending.length; index += 1) {
    const region = pending[index];
    if (region === undefined) {
      continue;
    }
    if (region.endMs - region.startMs >= SHORT_TURN_MS) {
      kept.push(region);
      continue;
    }
    const previous = kept[kept.length - 1];
    const next = pending[index + 1];
    if (previous !== undefined && region.startMs - previous.endMs <= JOIN_GAP_MS) {
      previous.endMs = region.endMs;
      continue;
    }
    if (next !== undefined && next.startMs - region.endMs <= JOIN_GAP_MS) {
      next.startMs = region.startMs;
      continue;
    }
    kept.push(region);
  }
  return kept;
}

function appendSpan(slices: PlannedSlice[], regionStart: number, regionEnd: number): void {
  if (regionEnd - regionStart <= SLICE_MS) {
    slices.push({
      index: slices.length,
      startMs: regionStart,
      endMs: regionEnd,
      keepStartMs: regionStart,
      keepEndMs: regionEnd,
    });
    return;
  }
  for (let start = regionStart; start < regionEnd; start += STEP_MS) {
    const end = Math.min(start + SLICE_MS, regionEnd);
    const keepEnd = end === regionEnd ? regionEnd : start + STEP_MS;
    slices.push({
      index: slices.length,
      startMs: start,
      endMs: end,
      keepStartMs: start,
      keepEndMs: keepEnd,
    });
    if (end === regionEnd) {
      break;
    }
  }
}
