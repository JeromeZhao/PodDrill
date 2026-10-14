import { asRecord } from "./disk.ts";
import type { Turn } from "./turns.ts";

const UNGROUPED = "ungrouped";

export interface CueText {
  readonly id: string;
  readonly startMs: number;
  readonly endMs: number;
  readonly text: string;
}

type Nearest =
  | { readonly nearestGroupId: string; readonly nearestCosine: number }
  | { readonly nearestGroupId: null; readonly nearestCosine: null };

export type CueAssignment = { readonly id: string; readonly groupId: string } & Nearest;

export type CueRow = {
  readonly id: string;
  readonly startMs: number;
  readonly endMs: number;
  readonly text: string;
  readonly groupId: string;
} & Nearest;

export interface StoredLabel {
  readonly groupId: string;
  readonly label: string;
}

type GroupLabel =
  | { readonly kind: "name"; readonly name: string }
  | { readonly kind: "undetermined" }
  | { readonly kind: "quote" }
  | { readonly kind: "ending" };

export type CuePage =
  | { readonly kind: "page"; readonly cues: readonly CueRow[] }
  | { readonly kind: "unknown-group"; readonly groupId: string }
  | { readonly kind: "unknown-cue"; readonly cueId: string };

const TIME =
  /^(\d{2}):(\d{2}):(\d{2})\.(\d{3}) --> (\d{2}):(\d{2}):(\d{2})\.(\d{3})$/;

export function readVttCues(vtt: string): readonly CueText[] {
  const cues: CueText[] = [];
  for (const block of vtt.replaceAll("\r\n", "\n").split("\n\n")) {
    const lines = block.split("\n").filter((line) => line.length > 0);
    const timeIndex = lines.findIndex((line) => TIME.test(line));
    if (timeIndex <= 0) {
      continue;
    }
    const id = lines[timeIndex - 1];
    const stamp = lines[timeIndex];
    if (id === undefined || stamp === undefined) {
      continue;
    }
    const match = TIME.exec(stamp);
    if (match === null) {
      continue;
    }
    cues.push({
      id,
      startMs: stampMs(match[1], match[2], match[3], match[4]),
      endMs: stampMs(match[5], match[6], match[7], match[8]),
      text: lines.slice(timeIndex + 1).join("\n"),
    });
  }
  return cues;
}

export function assignCues(
  cues: readonly CueText[],
  turns: readonly Turn[],
  centroids: readonly (readonly number[])[],
): readonly CueAssignment[] {
  const speakerOfCue = cues.map((cue) => overlappingSpeaker(turns, cue.startMs, cue.endMs));
  const members = new Map<number, CueText[]>();
  for (let index = 0; index < cues.length; index += 1) {
    const speaker = speakerOfCue[index];
    const cue = cues[index];
    if (speaker === undefined || cue === undefined) {
      continue;
    }
    const list = members.get(speaker);
    if (list === undefined) {
      members.set(speaker, [cue]);
    } else {
      list.push(cue);
    }
  }
  const groupOfSpeaker = new Map<number, string>();
  const centroidOfGroup = new Map<string, readonly number[]>();
  for (const [speaker, groupCues] of members) {
    const first = groupCues[0];
    const centroid = centroids[speaker];
    if (first === undefined || centroid === undefined) {
      continue;
    }
    const groupId = `g${first.id}`;
    groupOfSpeaker.set(speaker, groupId);
    centroidOfGroup.set(groupId, centroid);
  }
  return cues.map((cue, index) => {
    const speaker = speakerOfCue[index];
    const groupId = speaker === undefined ? undefined : groupOfSpeaker.get(speaker);
    const centroid = speaker === undefined ? undefined : centroids[speaker];
    if (groupId === undefined || centroid === undefined) {
      return { id: cue.id, groupId: UNGROUPED, nearestGroupId: null, nearestCosine: null };
    }
    return { id: cue.id, groupId, ...nearestGroup(centroid, groupId, centroidOfGroup) };
  });
}

export function cueRows(
  cues: readonly CueText[],
  assignments: readonly CueAssignment[],
): readonly CueRow[] {
  const byId = new Map(assignments.map((assignment) => [assignment.id, assignment]));
  return cues.map((cue) => {
    const assignment = byId.get(cue.id);
    if (assignment === undefined) {
      return {
        id: cue.id,
        startMs: cue.startMs,
        endMs: cue.endMs,
        text: cue.text,
        groupId: UNGROUPED,
        nearestGroupId: null,
        nearestCosine: null,
      };
    }
    return {
      id: cue.id,
      startMs: cue.startMs,
      endMs: cue.endMs,
      text: cue.text,
      groupId: assignment.groupId,
      nearestGroupId: assignment.nearestGroupId,
      nearestCosine: assignment.nearestCosine,
    };
  });
}

export function readAssignments(value: unknown): readonly CueAssignment[] | undefined {
  const record = asRecord(value);
  if (record === undefined || !Array.isArray(record["cues"])) {
    return undefined;
  }
  const assignments: CueAssignment[] = [];
  for (const item of record["cues"]) {
    const parsed = readAssignment(item);
    if (parsed === undefined) {
      return undefined;
    }
    assignments.push(parsed);
  }
  return assignments;
}

export function knownGroupIds(rows: readonly CueRow[]): ReadonlySet<string> {
  const ids = new Set<string>([UNGROUPED]);
  for (const row of rows) {
    ids.add(row.groupId);
  }
  return ids;
}

export function pageCues(
  rows: readonly CueRow[],
  knownGroups: ReadonlySet<string>,
  limit: number,
  after: string | undefined,
  groupId: string | undefined,
): CuePage {
  if (groupId !== undefined && !knownGroups.has(groupId)) {
    return { kind: "unknown-group", groupId };
  }
  const filtered = groupId === undefined ? rows : rows.filter((row) => row.groupId === groupId);
  let start = 0;
  if (after !== undefined) {
    const index = filtered.findIndex((row) => row.id === after);
    if (index === -1) {
      return { kind: "unknown-cue", cueId: after };
    }
    start = index + 1;
  }
  return { kind: "page", cues: filtered.slice(start, start + limit) };
}

export function parseLabelUpdates(value: unknown): readonly StoredLabel[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const updates: StoredLabel[] = [];
  for (const item of value) {
    const record = asRecord(item);
    if (record === undefined) {
      return undefined;
    }
    const groupId = record["groupId"];
    const label = record["label"];
    if (typeof groupId !== "string" || groupId === "" || typeof label !== "string") {
      return undefined;
    }
    if (parseLabel(label) === undefined) {
      return undefined;
    }
    updates.push({ groupId, label });
  }
  return updates;
}

export function readLabels(value: unknown): readonly StoredLabel[] | undefined {
  const record = asRecord(value);
  if (record === undefined || !Array.isArray(record["groups"])) {
    return undefined;
  }
  return parseLabelUpdates(record["groups"]);
}

export function mergeLabels(
  current: readonly StoredLabel[],
  updates: readonly StoredLabel[],
): readonly StoredLabel[] {
  const map = new Map<string, string>();
  for (const label of current) {
    map.set(label.groupId, label.label);
  }
  for (const label of updates) {
    map.set(label.groupId, label.label);
  }
  return [...map.entries()]
    .sort((left, right) => compareText(left[0], right[0]))
    .map(([groupId, label]) => ({ groupId, label }));
}

/** Person names only. `quote` and `ending` are marks, and `undetermined` is not a name. */
export function hostNames(labels: readonly StoredLabel[]): readonly string[] {
  const names: string[] = [];
  for (const stored of labels) {
    const parsed = parseLabel(stored.label);
    if (parsed === undefined) {
      continue;
    }
    const name = personName(parsed);
    if (name !== undefined) {
      names.push(name);
    }
  }
  return names;
}

function personName(label: GroupLabel): string | undefined {
  switch (label.kind) {
    case "name":
      return label.name;
    case "undetermined":
    case "quote":
    case "ending":
      return undefined;
    default: {
      const leftover: never = label;
      throw new Error(`unexpected label ${JSON.stringify(leftover)}`);
    }
  }
}

function parseLabel(label: string): GroupLabel | undefined {
  if (label === "") {
    return undefined;
  }
  switch (label) {
    case "undetermined":
      return { kind: "undetermined" };
    case "quote":
      return { kind: "quote" };
    case "ending":
      return { kind: "ending" };
    default:
      return { kind: "name", name: label };
  }
}

function readAssignment(value: unknown): CueAssignment | undefined {
  const record = asRecord(value);
  if (record === undefined) {
    return undefined;
  }
  const id = record["id"];
  const groupId = record["groupId"];
  const nearestGroupId = readNullableString(record["nearestGroupId"]);
  const nearestCosine = readNullableNumber(record["nearestCosine"]);
  if (typeof id !== "string" || id === "" || typeof groupId !== "string" || groupId === "") {
    return undefined;
  }
  if (nearestGroupId === undefined || nearestCosine === undefined) {
    return undefined;
  }
  if ((nearestGroupId === null) !== (nearestCosine === null)) {
    return undefined;
  }
  if (nearestGroupId === null || nearestCosine === null) {
    return { id, groupId, nearestGroupId: null, nearestCosine: null };
  }
  return { id, groupId, nearestGroupId, nearestCosine };
}

function readNullableString(value: unknown): string | null | undefined {
  if (value === null) {
    return null;
  }
  return typeof value === "string" && value !== "" ? value : undefined;
}

function readNullableNumber(value: unknown): number | null | undefined {
  if (value === null) {
    return null;
  }
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function overlappingSpeaker(turns: readonly Turn[], startMs: number, endMs: number): number | undefined {
  let bestSpeaker: number | undefined;
  let bestOverlap = 0;
  for (const turn of turns) {
    const overlap = Math.min(endMs, turn.endMs) - Math.max(startMs, turn.startMs);
    if (overlap > bestOverlap) {
      bestOverlap = overlap;
      bestSpeaker = turn.speaker;
    }
  }
  return bestSpeaker;
}

function nearestGroup(
  vector: readonly number[],
  groupId: string,
  centroids: ReadonlyMap<string, readonly number[]>,
): Nearest {
  let bestId: string | undefined;
  let bestScore = 0;
  for (const [otherId, centroid] of centroids) {
    if (otherId === groupId) {
      continue;
    }
    const score = cosine(vector, centroid);
    if (bestId === undefined || score > bestScore || (score === bestScore && otherId < bestId)) {
      bestId = otherId;
      bestScore = score;
    }
  }
  if (bestId === undefined) {
    return { nearestGroupId: null, nearestCosine: null };
  }
  return { nearestGroupId: bestId, nearestCosine: bestScore };
}

function cosine(left: readonly number[], right: readonly number[]): number {
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const a = left[index];
    const b = right[index];
    if (a === undefined || b === undefined) {
      continue;
    }
    dot += a * b;
    leftNorm += a * a;
    rightNorm += b * b;
  }
  const denom = Math.sqrt(leftNorm) * Math.sqrt(rightNorm);
  return denom === 0 ? 0 : dot / denom;
}

function stampMs(
  hours: string | undefined,
  minutes: string | undefined,
  seconds: string | undefined,
  millis: string | undefined,
): number {
  return Number(hours) * 3_600_000 + Number(minutes) * 60_000 + Number(seconds) * 1_000 + Number(millis);
}

function compareText(left: string, right: string): number {
  if (left === right) {
    return 0;
  }
  return left < right ? -1 : 1;
}
