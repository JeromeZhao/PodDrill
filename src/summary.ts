import { randomBytes } from "node:crypto";

import { parseDocument, stringify } from "yaml";

import { asRecord } from "./disk.ts";
import type { CueText } from "./groups.ts";

export type SummaryId = string & { readonly __brand: "SummaryId" };

export interface SummaryHead {
  readonly summaryId: SummaryId;
}

export interface SummaryParagraph {
  readonly index: number;
  readonly text: string;
  readonly cues: readonly string[];
  readonly startMs: number;
  readonly endMs: number;
}

export interface SummaryDocument {
  readonly version: 1;
  readonly episodeId: string;
  readonly summaryId: SummaryId;
  readonly summary: string;
  readonly paragraphs: readonly SummaryParagraph[];
}

export interface CueSetInput {
  readonly text: string;
  readonly cues: readonly string[];
  readonly startMs: number | undefined;
  readonly endMs: number | undefined;
}

type Checked<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly message: string };

const SUMMARY_ID = /^sm_[0-9a-f]{16}$/;
const POST_FIELDS = ["text", "cues", "startMs", "endMs"];
const PUT_FIELDS = ["index", "text", "cues", "startMs", "endMs"];
const FILE_FIELDS = ["version", "episodeId", "summaryId", "summary", "paragraphs"];
const PARAGRAPH_FIELDS = ["index", "text", "cues", "startMs", "endMs"];

const parseOptions = {
  schema: "core" as const,
  uniqueKeys: true as const,
  maxAliasCount: 0,
};

const dumpOptions = {
  aliasDuplicateObjects: false,
  lineWidth: 0,
  schema: "core" as const,
};

export function freshSummaryId(): SummaryId {
  return asSummaryId(`sm_${randomBytes(8).toString("hex")}`);
}

export function parseSummaryId(value: string): SummaryId | undefined {
  return SUMMARY_ID.test(value) ? asSummaryId(value) : undefined;
}

export function requireSummaryText(summary: unknown): Checked<string> {
  if (typeof summary !== "string" || summary === "") {
    return { ok: false, message: "summary must be a non-empty string" };
  }
  return { ok: true, value: summary };
}

export function emptySummary(episodeId: string, summaryId: SummaryId): SummaryDocument {
  return {
    version: 1,
    episodeId,
    summaryId,
    summary: "",
    paragraphs: [],
  };
}

export function dumpSummary(document: SummaryDocument): string {
  const dumped = stringify(
    {
      version: document.version,
      episodeId: document.episodeId,
      summaryId: document.summaryId,
      summary: document.summary,
      paragraphs: document.paragraphs.map((paragraph) => ({
        index: paragraph.index,
        text: paragraph.text,
        cues: paragraph.cues,
        startMs: paragraph.startMs,
        endMs: paragraph.endMs,
      })),
    },
    dumpOptions,
  );
  return dumped;
}

export function parseSummaryFile(
  text: string,
  episodeId: string,
  summaryId: SummaryId,
): SummaryDocument | undefined {
  const doc = parseDocument(text, parseOptions);
  // yaml 2 reports an unresolved tag such as !!js/function as a warning, not an error.
  if (doc.errors.length > 0 || doc.warnings.length > 0) {
    return undefined;
  }
  let value: unknown;
  try {
    value = doc.toJS({ maxAliasCount: 0 });
  } catch {
    return undefined;
  }
  return narrowSummary(value, episodeId, summaryId);
}

export function inspectPostBody(body: unknown): Checked<CueSetInput> {
  const record = asRecord(body);
  if (record === undefined) {
    return { ok: false, message: "postParagraph expects { text, cues }" };
  }
  if (Object.hasOwn(record, "index")) {
    return { ok: false, message: "postParagraph rejects index" };
  }
  return readCueSet(record, POST_FIELDS, "postParagraph expects { text, cues }");
}

export function inspectPutBody(body: unknown): Checked<{ readonly index: number } & CueSetInput> {
  const record = asRecord(body);
  if (record === undefined || !Object.hasOwn(record, "index")) {
    return { ok: false, message: "putParagraph requires index" };
  }
  const index = positiveIndex(record["index"]);
  if (index === undefined) {
    return { ok: false, message: "putParagraph requires index" };
  }
  const span = readCueSet(record, PUT_FIELDS, "putParagraph expects { index, text, cues }");
  if (!span.ok) {
    return span;
  }
  return { ok: true, value: { index, ...span.value } };
}

export function orderCueSet(
  ids: readonly string[],
  startMs: number | undefined,
  endMs: number | undefined,
  cues: readonly CueText[],
): Checked<{ readonly cues: readonly string[]; readonly startMs: number; readonly endMs: number }> {
  if (ids.length === 0) {
    return { ok: false, message: "cues must list at least one cue" };
  }
  const seen = new Set<string>();
  const indexes: number[] = [];
  for (const id of ids) {
    if (seen.has(id)) {
      return { ok: false, message: "a cue is listed twice" };
    }
    seen.add(id);
    const index = cues.findIndex((cue) => cue.id === id);
    if (index < 0) {
      return { ok: false, message: "a cue is not in the transcript" };
    }
    indexes.push(index);
  }
  indexes.sort((left, right) => left - right);
  const ordered: string[] = [];
  let first: CueText | undefined;
  let last: CueText | undefined;
  for (const index of indexes) {
    const cue = cues[index];
    if (cue === undefined) {
      return { ok: false, message: "a cue is not in the transcript" };
    }
    ordered.push(cue.id);
    if (first === undefined) {
      first = cue;
    }
    last = cue;
  }
  if (first === undefined || last === undefined) {
    return { ok: false, message: "cues must list at least one cue" };
  }
  if (startMs !== undefined && startMs !== first.startMs) {
    return { ok: false, message: "startMs does not match the cue" };
  }
  if (endMs !== undefined && endMs !== last.endMs) {
    return { ok: false, message: "endMs does not match the cue" };
  }
  return { ok: true, value: { cues: ordered, startMs: first.startMs, endMs: last.endMs } };
}

function narrowSummary(value: unknown, episodeId: string, summaryId: SummaryId): SummaryDocument | undefined {
  const record = asRecord(value);
  if (record === undefined || !exactKeys(record, FILE_FIELDS)) {
    return undefined;
  }
  const summary = record["summary"];
  const paragraphs = record["paragraphs"];
  if (
    record["version"] !== 1 ||
    record["episodeId"] !== episodeId ||
    record["summaryId"] !== summaryId ||
    typeof summary !== "string" ||
    !Array.isArray(paragraphs)
  ) {
    return undefined;
  }
  const parsed: SummaryParagraph[] = [];
  for (let position = 0; position < paragraphs.length; position += 1) {
    const paragraph = narrowParagraph(paragraphs[position], position + 1);
    if (paragraph === undefined) {
      return undefined;
    }
    parsed.push(paragraph);
  }
  return {
    version: 1,
    episodeId,
    summaryId,
    summary,
    paragraphs: parsed,
  };
}

function narrowParagraph(value: unknown, index: number): SummaryParagraph | undefined {
  const record = asRecord(value);
  if (record === undefined || !exactKeys(record, PARAGRAPH_FIELDS)) {
    return undefined;
  }
  const text = record["text"];
  const cues = cueIdList(record["cues"]);
  const startMs = record["startMs"];
  const endMs = record["endMs"];
  if (
    record["index"] !== index ||
    typeof text !== "string" ||
    text === "" ||
    cues === undefined ||
    typeof startMs !== "number" ||
    !Number.isFinite(startMs) ||
    typeof endMs !== "number" ||
    !Number.isFinite(endMs)
  ) {
    return undefined;
  }
  return { index, text, cues, startMs, endMs };
}

function readCueSet(record: Record<string, unknown>, fields: readonly string[], message: string): Checked<CueSetInput> {
  for (const key of Object.keys(record)) {
    if (key === "index") {
      continue;
    }
    if (!fields.includes(key)) {
      return { ok: false, message };
    }
  }
  const text = nonEmpty(record["text"]);
  const cues = cueIdList(record["cues"]);
  if (text === undefined || cues === undefined) {
    return { ok: false, message };
  }
  const startMs = optionalMs(record, "startMs");
  if (!startMs.ok) {
    return startMs;
  }
  const endMs = optionalMs(record, "endMs");
  if (!endMs.ok) {
    return endMs;
  }
  return {
    ok: true,
    value: { text, cues, startMs: startMs.value, endMs: endMs.value },
  };
}

function cueIdList(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value) || value.length === 0) {
    return undefined;
  }
  const ids: string[] = [];
  for (const item of value) {
    if (typeof item !== "string" || item === "") {
      return undefined;
    }
    ids.push(item);
  }
  return ids;
}

function optionalMs(record: Record<string, unknown>, key: string): Checked<number | undefined> {
  if (!Object.hasOwn(record, key)) {
    return { ok: true, value: undefined };
  }
  const value = record[key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return { ok: false, message: `${key} must be a number` };
  }
  return { ok: true, value };
}

function nonEmpty(value: unknown): string | undefined {
  if (typeof value !== "string" || value === "") {
    return undefined;
  }
  return value;
}

function positiveIndex(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    return undefined;
  }
  return value;
}

function exactKeys(record: Record<string, unknown>, keys: readonly string[]): boolean {
  const found = Object.keys(record);
  return found.length === keys.length && keys.every((key) => Object.hasOwn(record, key));
}

function asSummaryId(value: string): SummaryId {
  return value as SummaryId;
}
