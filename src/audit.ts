import { randomBytes } from "node:crypto";
import { readFile, rename, rm, writeFile } from "node:fs/promises";

import { asRecord, errorCode, pathExists } from "./disk.ts";
import {
  artifactKinds,
  episodeLayout,
  parseEpisodeId,
  type ArtifactKind,
  type WorkspaceRoot,
} from "./workspace.ts";

const artifactStates = ["waiting", "queued", "running", "ready", "failed"] as const;

type ArtifactStateName = (typeof artifactStates)[number];

type ArtifactSnap = {
  readonly name: ArtifactKind;
  readonly state: ArtifactStateName;
};

type ErrorResult = { readonly kind: "error"; readonly message: string };

type RejectedResult = { readonly kind: "rejected"; readonly reason: string };

type NotReadyResult = { readonly state: "not-ready"; readonly on: ArtifactKind };

type Failure = ErrorResult | RejectedResult | NotReadyResult;

type UnknownResult = { readonly state: "unknown" };

type CuesRequest = {
  readonly limit?: number;
  readonly after?: string;
  readonly groupId?: string;
  readonly hosts?: boolean;
};

type CuesPresent =
  | { readonly state: "present"; readonly count: 0 }
  | {
      readonly state: "present";
      readonly count: number;
      readonly first: string;
      readonly last: string;
    };

type OpenRequest =
  | { readonly type: string; readonly request: string }
  | { readonly type: string }
  | { readonly request: string }
  | Record<string, never>;

type ParagraphRequest =
  | { readonly summaryId: string; readonly cues: readonly string[] }
  | { readonly summaryId: string };

type SetSummaryRequest =
  | { readonly summaryId: string; readonly length: number }
  | { readonly summaryId: string };

type PresentState = { readonly state: "present" };

type IndexedState = { readonly state: "present"; readonly index: number };

type OpenPresent =
  | { readonly state: "present"; readonly summaryId: string }
  | PresentState;

export type AuditLine =
  | {
      readonly at: string;
      readonly op: "start";
      readonly request: { readonly language: string };
      readonly result: { readonly kind: "started"; readonly created: boolean };
    }
  | {
      readonly at: string;
      readonly op: "episode";
      readonly request: Record<string, never>;
      readonly result:
        | { readonly state: "present"; readonly artifacts: readonly ArtifactSnap[] }
        | Failure;
    }
  | {
      readonly at: string;
      readonly op: "cues";
      readonly request: CuesRequest;
      readonly result: CuesPresent | UnknownResult | Failure;
    }
  | {
      readonly at: string;
      readonly op: "labelGroups";
      readonly request: { readonly groups: readonly { readonly groupId: string; readonly label: string }[] };
      readonly result: PresentState | UnknownResult | Failure;
    }
  | {
      readonly at: string;
      readonly op: "startSummary";
      readonly request: Record<string, never>;
      readonly result: OpenPresent | UnknownResult | Failure;
    }
  | {
      readonly at: string;
      readonly op: "openSummary";
      readonly request: OpenRequest;
      readonly result: OpenPresent | UnknownResult | Failure;
    }
  | {
      readonly at: string;
      readonly op: "setSummary";
      readonly request: SetSummaryRequest;
      readonly result: PresentState | UnknownResult | Failure;
    }
  | {
      readonly at: string;
      readonly op: "putParagraph";
      readonly request: ParagraphRequest;
      readonly result: IndexedState | PresentState | UnknownResult | Failure;
    }
  | {
      readonly at: string;
      readonly op: "postParagraph";
      readonly request: ParagraphRequest;
      readonly result: IndexedState | PresentState | UnknownResult | Failure;
    }
  | {
      readonly at: string;
      readonly op: "summary";
      readonly request: { readonly summaryId: string };
      readonly result: PresentState | UnknownResult | Failure;
    };

type AuditOp = AuditLine["op"];

export type AuditedRequest =
  | { readonly op: "ping" }
  | { readonly op: "audit"; readonly episodeId: string }
  | { readonly op: "start"; readonly audioPath: string; readonly language?: string }
  | { readonly op: "episode"; readonly episodeId: string }
  | {
      readonly op: "cues";
      readonly episodeId: string;
      readonly limit?: number;
      readonly after?: string;
      readonly groupId?: string;
      readonly hosts?: boolean;
    }
  | { readonly op: "labelGroups"; readonly episodeId: string; readonly groups: unknown }
  | { readonly op: "startSummary"; readonly episodeId: string }
  | { readonly op: "setSummary"; readonly episodeId: string; readonly summaryId: string; readonly summary: unknown }
  | { readonly op: "putParagraph"; readonly episodeId: string; readonly summaryId: string; readonly body: unknown }
  | { readonly op: "postParagraph"; readonly episodeId: string; readonly summaryId: string; readonly body: unknown }
  | { readonly op: "summary"; readonly episodeId: string; readonly summaryId: string };

export type AuditDump =
  | { readonly state: "present"; readonly episodeId: string; readonly records: readonly AuditLine[] }
  | { readonly state: "unknown"; readonly episodeId: string }
  | { readonly kind: "error"; readonly message: "the audit could not be read" };

const unreadable = "the audit could not be read";

type Gate =
  | { readonly kind: "drop" }
  | { readonly kind: "replace"; readonly result: Failure }
  | { readonly kind: "go" };

/** One chain per audit file so two appends cannot tear a line. */
const auditWrites = new Map<string, Promise<void>>();

export function auditRecord(call: AuditedRequest, response: object, at: string): AuditLine | undefined {
  const body = asRecord(response);
  if (body === undefined) {
    return undefined;
  }
  switch (call.op) {
    case "ping":
    case "audit":
      return undefined;
    case "start":
      return startLine(call, body, at);
    case "episode":
      return episodeLine(body, at);
    case "cues":
      return cuesLine(call, body, at);
    case "labelGroups":
      return labelLine(call, body, at);
    case "startSummary":
      return openLine(body, at);
    case "setSummary":
      return setLine(call, body, at);
    case "putParagraph":
      return paragraphLine("putParagraph", call, body, at);
    case "postParagraph":
      return paragraphLine("postParagraph", call, body, at);
    case "summary":
      return summaryLine(call, body, at);
    default: {
      const leftover: never = call;
      throw new Error(`unexpected ${JSON.stringify(leftover)}`);
    }
  }
}

export async function appendAudit(root: WorkspaceRoot, episodeId: string, record: AuditLine): Promise<void> {
  const id = parseEpisodeId(episodeId);
  if (id === undefined) {
    return;
  }
  const layout = episodeLayout(root, id);
  await withAuditPath(layout.audit, async () => {
    if (!(await pathExists(layout.dir))) {
      return;
    }
    const current = await readText(layout.audit);
    await replaceFile(layout.audit, `${current}${JSON.stringify(record)}\n`);
  });
}

export async function readAudit(root: WorkspaceRoot, episodeId: string): Promise<AuditDump> {
  const id = parseEpisodeId(episodeId);
  if (id === undefined) {
    return { state: "unknown", episodeId };
  }
  const layout = episodeLayout(root, id);
  if (!(await pathExists(layout.dir))) {
    return { state: "unknown", episodeId };
  }
  if (!(await pathExists(layout.audit))) {
    return { state: "present", episodeId, records: [] };
  }
  let text: string;
  try {
    text = await readFile(layout.audit, "utf8");
  } catch {
    return { kind: "error", message: unreadable };
  }
  const records = parseAuditText(text);
  if (records === undefined) {
    return { kind: "error", message: unreadable };
  }
  return { state: "present", episodeId, records };
}

function startLine(
  call: Extract<AuditedRequest, { readonly op: "start" }>,
  response: Record<string, unknown>,
  at: string,
): AuditLine | undefined {
  if (response["kind"] !== "started" || typeof response["created"] !== "boolean") {
    return undefined;
  }
  const language = call.language === undefined ? "en" : call.language;
  return {
    at,
    op: "start",
    request: { language },
    result: { kind: "started", created: response["created"] },
  };
}

function episodeLine(response: Record<string, unknown>, at: string): AuditLine | undefined {
  const result = gated(response, () => {
    if (response["state"] !== "present") {
      return undefined;
    }
    const artifacts = episodeArtifacts(response["artifacts"]);
    if (artifacts === undefined) {
      return undefined;
    }
    return { state: "present" as const, artifacts };
  });
  if (result === undefined) {
    return undefined;
  }
  return { at, op: "episode", request: {}, result };
}

function cuesLine(
  call: Extract<AuditedRequest, { readonly op: "cues" }>,
  response: Record<string, unknown>,
  at: string,
): AuditLine | undefined {
  const request = cuesRequest(call);
  const result = gated(response, () => cuesSuccess(response));
  if (result === undefined) {
    return undefined;
  }
  return { at, op: "cues", request, result };
}

function labelLine(
  call: Extract<AuditedRequest, { readonly op: "labelGroups" }>,
  response: Record<string, unknown>,
  at: string,
): AuditLine | undefined {
  const result = gated(response, () => stateOnly(response));
  if (result === undefined) {
    return undefined;
  }
  return { at, op: "labelGroups", request: { groups: labelPairs(call.groups) }, result };
}

function openLine(response: Record<string, unknown>, at: string): AuditLine | undefined {
  const result = gated(response, () => openSuccess(response));
  if (result === undefined) {
    return undefined;
  }
  return { at, op: "startSummary", request: {}, result };
}

function setLine(
  call: Extract<AuditedRequest, { readonly op: "setSummary" }>,
  response: Record<string, unknown>,
  at: string,
): AuditLine | undefined {
  const result = gated(response, () => stateOnly(response));
  if (result === undefined) {
    return undefined;
  }
  return { at, op: "setSummary", request: setRequest(call.summaryId, call.summary), result };
}

function paragraphLine(
  op: "putParagraph" | "postParagraph",
  call: Extract<AuditedRequest, { readonly op: "putParagraph" | "postParagraph" }>,
  response: Record<string, unknown>,
  at: string,
): AuditLine | undefined {
  const result = gated(response, () => paragraphSuccess(response, call.body));
  if (result === undefined) {
    return undefined;
  }
  return { at, op, request: paragraphRequest(call.summaryId, call.body), result };
}

function summaryLine(
  call: Extract<AuditedRequest, { readonly op: "summary" }>,
  response: Record<string, unknown>,
  at: string,
): AuditLine | undefined {
  const result = gated(response, () => stateOnly(response));
  if (result === undefined) {
    return undefined;
  }
  return { at, op: "summary", request: { summaryId: call.summaryId }, result };
}

function gated<R>(response: Record<string, unknown>, success: () => R | undefined): R | Failure | undefined {
  const decision = gate(response);
  switch (decision.kind) {
    case "drop":
      return undefined;
    case "replace":
      return decision.result;
    case "go":
      return success();
    default: {
      const leftover: never = decision;
      throw new Error(`unexpected ${JSON.stringify(leftover)}`);
    }
  }
}

function gate(response: Record<string, unknown>): Gate {
  if (response["kind"] === "error") {
    return typeof response["message"] === "string"
      ? { kind: "replace", result: { kind: "error", message: response["message"] } }
      : { kind: "drop" };
  }
  if (response["kind"] === "rejected") {
    return typeof response["reason"] === "string"
      ? { kind: "replace", result: { kind: "rejected", reason: response["reason"] } }
      : { kind: "drop" };
  }
  if (response["state"] === "not-ready") {
    return isArtifactKind(response["on"])
      ? { kind: "replace", result: { state: "not-ready", on: response["on"] } }
      : { kind: "drop" };
  }
  if (unknownEpisode(response)) {
    return { kind: "drop" };
  }
  return { kind: "go" };
}

function unknownEpisode(response: Record<string, unknown>): boolean {
  return (
    response["state"] === "unknown" &&
    response["groupId"] === undefined &&
    response["cueId"] === undefined &&
    response["summaryId"] === undefined
  );
}

function cuesRequest(call: Extract<AuditedRequest, { readonly op: "cues" }>): CuesRequest {
  return {
    ...(call.limit === undefined ? {} : { limit: call.limit }),
    ...(call.after === undefined ? {} : { after: call.after }),
    ...(call.groupId === undefined ? {} : { groupId: call.groupId }),
    ...(call.hosts === undefined ? {} : { hosts: call.hosts }),
  };
}

function cuesSuccess(response: Record<string, unknown>): CuesPresent | UnknownResult | undefined {
  if (response["state"] === "unknown") {
    return { state: "unknown" };
  }
  if (response["state"] !== "present") {
    return undefined;
  }
  return cueSpan(response["cues"]);
}

function cueSpan(cues: unknown): CuesPresent | undefined {
  if (!Array.isArray(cues)) {
    return undefined;
  }
  const ids: string[] = [];
  for (const cue of cues) {
    const record = asRecord(cue);
    if (record === undefined || typeof record["id"] !== "string") {
      return undefined;
    }
    ids.push(record["id"]);
  }
  if (ids.length === 0) {
    return { state: "present", count: 0 };
  }
  const first = ids[0];
  const last = ids[ids.length - 1];
  if (first === undefined || last === undefined) {
    return undefined;
  }
  return { state: "present", count: ids.length, first, last };
}

function stateOnly(response: Record<string, unknown>): PresentState | UnknownResult | undefined {
  if (response["state"] === "present") {
    return { state: "present" };
  }
  if (response["state"] === "unknown") {
    return { state: "unknown" };
  }
  return undefined;
}

function labelPairs(groups: unknown): readonly { readonly groupId: string; readonly label: string }[] {
  if (!Array.isArray(groups)) {
    return [];
  }
  const pairs: { readonly groupId: string; readonly label: string }[] = [];
  for (const item of groups) {
    const record = asRecord(item);
    if (record === undefined) {
      continue;
    }
    const groupId = record["groupId"];
    const label = record["label"];
    if (typeof groupId !== "string" || typeof label !== "string") {
      continue;
    }
    pairs.push({ groupId, label });
  }
  return pairs;
}

function openSuccess(response: Record<string, unknown>): OpenPresent | UnknownResult | undefined {
  if (response["state"] === "unknown") {
    return { state: "unknown" };
  }
  if (response["state"] !== "present") {
    return undefined;
  }
  if (typeof response["summaryId"] === "string") {
    return { state: "present", summaryId: response["summaryId"] };
  }
  return { state: "present" };
}

function setRequest(summaryId: string, summary: unknown): SetSummaryRequest {
  if (typeof summary !== "string") {
    return { summaryId };
  }
  return { summaryId, length: summary.length };
}

function paragraphRequest(summaryId: string, body: unknown): ParagraphRequest {
  const record = asRecord(body);
  const cues = record === undefined ? undefined : stringList(record["cues"]);
  if (cues === undefined) {
    return { summaryId };
  }
  return { summaryId, cues };
}

function stringList(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const ids: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") {
      return undefined;
    }
    ids.push(item);
  }
  return ids;
}

function paragraphSuccess(
  response: Record<string, unknown>,
  body: unknown,
): IndexedState | PresentState | UnknownResult | undefined {
  if (response["state"] === "unknown") {
    return { state: "unknown" };
  }
  if (response["state"] !== "present") {
    return undefined;
  }
  const index = writtenIndex(response, body);
  if (index === undefined) {
    return { state: "present" };
  }
  return { state: "present", index };
}

function writtenIndex(response: Record<string, unknown>, body: unknown): number | undefined {
  if (isIndex(response["index"])) {
    return response["index"];
  }
  const paragraphs = response["paragraphs"];
  if (!Array.isArray(paragraphs)) {
    return undefined;
  }
  const requested = bodyIndex(body);
  if (requested !== undefined && paragraphs.some((item) => paragraphIndex(item) === requested)) {
    return requested;
  }
  if (paragraphs.length === 0) {
    return undefined;
  }
  return paragraphIndex(paragraphs[paragraphs.length - 1]);
}

function bodyIndex(body: unknown): number | undefined {
  const record = asRecord(body);
  if (record === undefined) {
    return undefined;
  }
  return isIndex(record["index"]) ? record["index"] : undefined;
}

function paragraphIndex(value: unknown): number | undefined {
  const record = asRecord(value);
  if (record === undefined || !isIndex(record["index"])) {
    return undefined;
  }
  return record["index"];
}

function isIndex(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value);
}

function episodeArtifacts(value: unknown): readonly ArtifactSnap[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const found = new Map<ArtifactKind, ArtifactStateName>();
  for (const item of value) {
    const record = asRecord(item);
    if (record === undefined) {
      return undefined;
    }
    const name = record["artifact"];
    const state = record["state"];
    if (!isArtifactKind(name) || !isArtifactState(state)) {
      return undefined;
    }
    found.set(name, state);
  }
  const snaps: ArtifactSnap[] = [];
  for (const name of artifactKinds) {
    const state = found.get(name);
    if (state === undefined) {
      return undefined;
    }
    snaps.push({ name, state });
  }
  return snaps;
}

function isArtifactKind(value: unknown): value is ArtifactKind {
  return artifactKinds.some((kind) => kind === value);
}

function isArtifactState(value: unknown): value is ArtifactStateName {
  return artifactStates.some((state) => state === value);
}

function withAuditPath(path: string, work: () => Promise<void>): Promise<void> {
  const previous = auditWrites.get(path) ?? Promise.resolve();
  const settled = previous.then(
    () => undefined,
    () => undefined,
  );
  const run = settled.then(work);
  auditWrites.set(
    path,
    run.then(
      () => undefined,
      () => undefined,
    ),
  );
  return run;
}

async function readText(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch (error: unknown) {
    if (errorCode(error) === "ENOENT") {
      return "";
    }
    throw error;
  }
}

async function replaceFile(target: string, text: string): Promise<void> {
  const temp = `${target}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    await writeFile(temp, text);
    await rename(temp, target);
  } catch (error: unknown) {
    await rm(temp, { force: true });
    throw error;
  }
}

function parseAuditText(text: string): readonly AuditLine[] | undefined {
  const parts = text.split("\n");
  if (parts.length > 0 && parts[parts.length - 1] === "") {
    parts.pop();
  }
  const records: AuditLine[] = [];
  for (const part of parts) {
    if (part === "") {
      return undefined;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(part);
    } catch {
      return undefined;
    }
    const line = parseAuditLine(parsed);
    if (line === undefined) {
      return undefined;
    }
    records.push(line);
  }
  return records;
}

function parseAuditLine(value: unknown): AuditLine | undefined {
  const record = asRecord(value);
  if (record === undefined || !keysAre(record, ["at", "op", "request", "result"])) {
    return undefined;
  }
  const at = record["at"];
  const op = record["op"];
  if (typeof at !== "string" || at === "" || !isAuditOp(op)) {
    return undefined;
  }
  switch (op) {
    case "start":
      return parseStart(at, record["request"], record["result"]);
    case "episode":
      return parseEpisode(at, record["request"], record["result"]);
    case "cues":
      return parseCues(at, record["request"], record["result"]);
    case "labelGroups":
      return parseLabels(at, record["request"], record["result"]);
    case "startSummary":
      return parseStartedSummary(at, record["request"], record["result"]);
    case "openSummary":
      return parseOpen(at, record["request"], record["result"]);
    case "setSummary":
      return parseSet(at, record["request"], record["result"]);
    case "putParagraph":
      return parseParagraph("putParagraph", at, record["request"], record["result"]);
    case "postParagraph":
      return parseParagraph("postParagraph", at, record["request"], record["result"]);
    case "summary":
      return parseSummary(at, record["request"], record["result"]);
    default: {
      const leftover: never = op;
      throw new Error(`unexpected ${JSON.stringify(leftover)}`);
    }
  }
}

function parseStart(at: string, request: unknown, result: unknown): AuditLine | undefined {
  const requestRecord = asRecord(request);
  const resultRecord = asRecord(result);
  if (
    requestRecord === undefined ||
    resultRecord === undefined ||
    !keysAre(requestRecord, ["language"]) ||
    typeof requestRecord["language"] !== "string" ||
    !keysAre(resultRecord, ["kind", "created"]) ||
    resultRecord["kind"] !== "started" ||
    typeof resultRecord["created"] !== "boolean"
  ) {
    return undefined;
  }
  return {
    at,
    op: "start",
    request: { language: requestRecord["language"] },
    result: { kind: "started", created: resultRecord["created"] },
  };
}

function parseEpisode(at: string, request: unknown, result: unknown): AuditLine | undefined {
  const requestRecord = asRecord(request);
  if (requestRecord === undefined || Object.keys(requestRecord).length !== 0) {
    return undefined;
  }
  const parsed = parseEpisodeResult(result);
  if (parsed === undefined) {
    return undefined;
  }
  return { at, op: "episode", request: {}, result: parsed };
}

function parseEpisodeResult(
  result: unknown,
): { readonly state: "present"; readonly artifacts: readonly ArtifactSnap[] } | Failure | undefined {
  const failure = parseFailure(result);
  if (failure !== undefined) {
    return failure;
  }
  const record = asRecord(result);
  if (record === undefined || !keysAre(record, ["state", "artifacts"]) || record["state"] !== "present") {
    return undefined;
  }
  const artifacts = parseSnaps(record["artifacts"]);
  if (artifacts === undefined) {
    return undefined;
  }
  return { state: "present", artifacts };
}

function parseSnaps(value: unknown): readonly ArtifactSnap[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const snaps: ArtifactSnap[] = [];
  for (const item of value) {
    const record = asRecord(item);
    if (
      record === undefined ||
      !keysAre(record, ["name", "state"]) ||
      !isArtifactKind(record["name"]) ||
      !isArtifactState(record["state"])
    ) {
      return undefined;
    }
    snaps.push({ name: record["name"], state: record["state"] });
  }
  return snaps;
}

function parseCues(at: string, request: unknown, result: unknown): AuditLine | undefined {
  const parsedRequest = parseCuesRequest(request);
  const parsedResult = parseCuesResult(result);
  if (parsedRequest === undefined || parsedResult === undefined) {
    return undefined;
  }
  return { at, op: "cues", request: parsedRequest, result: parsedResult };
}

function parseCuesRequest(value: unknown): CuesRequest | undefined {
  const record = asRecord(value);
  if (record === undefined) {
    return undefined;
  }
  for (const key of Object.keys(record)) {
    if (key !== "limit" && key !== "after" && key !== "groupId" && key !== "hosts") {
      return undefined;
    }
  }
  const limit = record["limit"];
  const after = record["after"];
  const groupId = record["groupId"];
  const hosts = record["hosts"];
  if (limit !== undefined && typeof limit !== "number") {
    return undefined;
  }
  if (after !== undefined && typeof after !== "string") {
    return undefined;
  }
  if (groupId !== undefined && typeof groupId !== "string") {
    return undefined;
  }
  if (hosts !== undefined && typeof hosts !== "boolean") {
    return undefined;
  }
  return {
    ...(typeof limit === "number" ? { limit } : {}),
    ...(typeof after === "string" ? { after } : {}),
    ...(typeof groupId === "string" ? { groupId } : {}),
    ...(typeof hosts === "boolean" ? { hosts } : {}),
  };
}

function parseCuesResult(value: unknown): CuesPresent | UnknownResult | Failure | undefined {
  const failure = parseFailure(value);
  if (failure !== undefined) {
    return failure;
  }
  const unknown = parseUnknown(value);
  if (unknown !== undefined) {
    return unknown;
  }
  const record = asRecord(value);
  if (record === undefined || record["state"] !== "present" || typeof record["count"] !== "number") {
    return undefined;
  }
  if (!Number.isInteger(record["count"]) || record["count"] < 0) {
    return undefined;
  }
  if (record["count"] === 0) {
    if (!keysAre(record, ["state", "count"])) {
      return undefined;
    }
    return { state: "present", count: 0 };
  }
  if (
    !keysAre(record, ["state", "count", "first", "last"]) ||
    typeof record["first"] !== "string" ||
    typeof record["last"] !== "string"
  ) {
    return undefined;
  }
  return { state: "present", count: record["count"], first: record["first"], last: record["last"] };
}

function parseLabels(at: string, request: unknown, result: unknown): AuditLine | undefined {
  const requestRecord = asRecord(request);
  const parsedResult = parseStateOrFailure(result);
  if (requestRecord === undefined || !keysAre(requestRecord, ["groups"]) || parsedResult === undefined) {
    return undefined;
  }
  const groups = parsePairs(requestRecord["groups"]);
  if (groups === undefined) {
    return undefined;
  }
  return { at, op: "labelGroups", request: { groups }, result: parsedResult };
}

function parsePairs(value: unknown): readonly { readonly groupId: string; readonly label: string }[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const pairs: { readonly groupId: string; readonly label: string }[] = [];
  for (const item of value) {
    const record = asRecord(item);
    if (
      record === undefined ||
      !keysAre(record, ["groupId", "label"]) ||
      typeof record["groupId"] !== "string" ||
      typeof record["label"] !== "string"
    ) {
      return undefined;
    }
    pairs.push({ groupId: record["groupId"], label: record["label"] });
  }
  return pairs;
}

function parseStartedSummary(at: string, request: unknown, result: unknown): AuditLine | undefined {
  const parsedRequest = parseOpenRequest(request);
  const parsedResult = parseOpenResult(result);
  if (parsedRequest === undefined || parsedResult === undefined || Object.keys(parsedRequest).length !== 0) {
    return undefined;
  }
  return { at, op: "startSummary", request: {}, result: parsedResult };
}

function parseOpen(at: string, request: unknown, result: unknown): AuditLine | undefined {
  const parsedRequest = parseOpenRequest(request);
  const parsedResult = parseOpenResult(result);
  if (parsedRequest === undefined || parsedResult === undefined) {
    return undefined;
  }
  return { at, op: "openSummary", request: parsedRequest, result: parsedResult };
}

function parseOpenRequest(value: unknown): OpenRequest | undefined {
  const record = asRecord(value);
  if (record === undefined) {
    return undefined;
  }
  const type = record["type"];
  const request = record["request"];
  const keys = Object.keys(record);
  if (keys.length === 0) {
    return {};
  }
  // Lines written when open stored a type still name that field. New lines store request only.
  if (keys.length === 2 && typeof type === "string" && typeof request === "string" && keysAre(record, ["type", "request"])) {
    return { type, request };
  }
  if (keys.length === 1 && typeof type === "string" && keysAre(record, ["type"])) {
    return { type };
  }
  if (keys.length === 1 && typeof request === "string" && keysAre(record, ["request"])) {
    return { request };
  }
  return undefined;
}

function parseOpenResult(value: unknown): OpenPresent | UnknownResult | Failure | undefined {
  const failure = parseFailure(value);
  if (failure !== undefined) {
    return failure;
  }
  const unknown = parseUnknown(value);
  if (unknown !== undefined) {
    return unknown;
  }
  const record = asRecord(value);
  if (record === undefined || record["state"] !== "present") {
    return undefined;
  }
  if (keysAre(record, ["state", "summaryId"]) && typeof record["summaryId"] === "string") {
    return { state: "present", summaryId: record["summaryId"] };
  }
  if (keysAre(record, ["state"])) {
    return { state: "present" };
  }
  return undefined;
}

function parseSet(at: string, request: unknown, result: unknown): AuditLine | undefined {
  const parsedRequest = parseSetRequest(request);
  const parsedResult = parseStateOrFailure(result);
  if (parsedRequest === undefined || parsedResult === undefined) {
    return undefined;
  }
  return { at, op: "setSummary", request: parsedRequest, result: parsedResult };
}

function parseSetRequest(value: unknown): SetSummaryRequest | undefined {
  const record = asRecord(value);
  if (record === undefined || typeof record["summaryId"] !== "string") {
    return undefined;
  }
  if (keysAre(record, ["summaryId", "length"]) && isLength(record["length"])) {
    return { summaryId: record["summaryId"], length: record["length"] };
  }
  if (keysAre(record, ["summaryId"])) {
    return { summaryId: record["summaryId"] };
  }
  return undefined;
}

function parseParagraph(
  op: "putParagraph" | "postParagraph",
  at: string,
  request: unknown,
  result: unknown,
): AuditLine | undefined {
  const parsedRequest = parseParagraphRequest(request);
  const parsedResult = parseParagraphResult(result);
  if (parsedRequest === undefined || parsedResult === undefined) {
    return undefined;
  }
  return { at, op, request: parsedRequest, result: parsedResult };
}

function parseParagraphRequest(value: unknown): ParagraphRequest | undefined {
  const record = asRecord(value);
  if (record === undefined || typeof record["summaryId"] !== "string") {
    return undefined;
  }
  const summaryId = record["summaryId"];
  const cues = stringList(record["cues"]);
  if (keysAre(record, ["summaryId", "cues"]) && cues !== undefined) {
    return { summaryId, cues };
  }
  if (keysAre(record, ["summaryId"])) {
    return { summaryId };
  }
  return undefined;
}

function parseParagraphResult(value: unknown): IndexedState | PresentState | UnknownResult | Failure | undefined {
  const failure = parseFailure(value);
  if (failure !== undefined) {
    return failure;
  }
  const unknown = parseUnknown(value);
  if (unknown !== undefined) {
    return unknown;
  }
  const record = asRecord(value);
  if (record === undefined || record["state"] !== "present") {
    return undefined;
  }
  if (keysAre(record, ["state", "index"]) && isIndex(record["index"])) {
    return { state: "present", index: record["index"] };
  }
  if (keysAre(record, ["state"])) {
    return { state: "present" };
  }
  return undefined;
}

function parseSummary(at: string, request: unknown, result: unknown): AuditLine | undefined {
  const requestRecord = asRecord(request);
  const parsedResult = parseStateOrFailure(result);
  if (
    requestRecord === undefined ||
    !keysAre(requestRecord, ["summaryId"]) ||
    typeof requestRecord["summaryId"] !== "string" ||
    parsedResult === undefined
  ) {
    return undefined;
  }
  return { at, op: "summary", request: { summaryId: requestRecord["summaryId"] }, result: parsedResult };
}

function parseStateOrFailure(value: unknown): PresentState | UnknownResult | Failure | undefined {
  const failure = parseFailure(value);
  if (failure !== undefined) {
    return failure;
  }
  const unknown = parseUnknown(value);
  if (unknown !== undefined) {
    return unknown;
  }
  const record = asRecord(value);
  if (record === undefined || !keysAre(record, ["state"]) || record["state"] !== "present") {
    return undefined;
  }
  return { state: "present" };
}

function parseUnknown(value: unknown): UnknownResult | undefined {
  const record = asRecord(value);
  if (record === undefined || !keysAre(record, ["state"]) || record["state"] !== "unknown") {
    return undefined;
  }
  return { state: "unknown" };
}

function parseFailure(value: unknown): Failure | undefined {
  const record = asRecord(value);
  if (record === undefined) {
    return undefined;
  }
  if (keysAre(record, ["kind", "message"]) && record["kind"] === "error" && typeof record["message"] === "string") {
    return { kind: "error", message: record["message"] };
  }
  if (keysAre(record, ["kind", "reason"]) && record["kind"] === "rejected" && typeof record["reason"] === "string") {
    return { kind: "rejected", reason: record["reason"] };
  }
  if (
    keysAre(record, ["state", "on"]) &&
    record["state"] === "not-ready" &&
    isArtifactKind(record["on"])
  ) {
    return { state: "not-ready", on: record["on"] };
  }
  return undefined;
}

function isLength(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function isAuditOp(value: unknown): value is AuditOp {
  switch (value) {
    case "start":
    case "episode":
    case "cues":
    case "labelGroups":
    case "startSummary":
    case "openSummary":
    case "setSummary":
    case "putParagraph":
    case "postParagraph":
    case "summary":
      return true;
    default:
      return false;
  }
}

function keysAre(record: Record<string, unknown>, keys: readonly string[]): boolean {
  const present = Object.keys(record);
  if (present.length !== keys.length) {
    return false;
  }
  return keys.every((key) => Object.hasOwn(record, key));
}
