#!/usr/bin/env node

import { spawn } from "node:child_process";
import { realpath } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { asRecord, errorCode } from "./disk.ts";
import { isModelId, type ModelFleet, type ModelId, type ModelWeights } from "./models.ts";
import { callOwner, ownerAlive, proxyMcp, render, serve } from "./owner.ts";
import { resolveWorkspace, setupWorkspace, type SetupResult } from "./workspace.ts";

const usage = [
  "usage: poddrill setup --provider <id> --queue-length <n> [--fleet-limit <n>] [--whistle-limit <n>]",
  "[--model-fleet <id>=<count>] [--model-weights <id>=<path>] [--embedding-limit <n>]",
  "| start <path> [--language <code>] | episode <episodeId> | cues <episodeId> [--limit <n>] [--after <cueId>] [--group-id <id>] [--hosts]",
  "| label-groups <episodeId> <json> | start-summary <episodeId> | set-summary <episodeId> <summaryId> <json>",
  "| put-paragraph <episodeId> <summaryId> <json> | post-paragraph <episodeId> <summaryId> <json> | summary <episodeId> <summaryId> | audit <episodeId> | serve | mcp",
].join(" ");

type PublicSetup =
  | {
      readonly kind: "ready";
      readonly provider: string;
      readonly queueLength: number;
      readonly fleetLimit: number;
      readonly embeddingLimit: number;
    }
  | {
      readonly kind: "rejected";
      readonly reason: "owner-running";
      readonly provider: string;
      readonly queueLength: number;
      readonly fleetLimit: number;
      readonly embeddingLimit: number;
      readonly message: string;
    };

async function main(): Promise<void> {
  const command = process.argv[2];
  switch (command) {
    case "setup":
      await runSetup(process.argv.slice(3));
      return;
    case "start":
      await runStart(process.argv.slice(3));
      return;
    case "episode":
      await runEpisode(process.argv[3]);
      return;
    case "cues":
      await runCues(process.argv.slice(3));
      return;
    case "label-groups":
      await runLabelGroups(process.argv[3], process.argv[4]);
      return;
    case "start-summary":
      await runStartSummary(process.argv[3]);
      return;
    case "set-summary":
      await runSetSummary(process.argv[3], process.argv[4], process.argv[5]);
      return;
    case "put-paragraph":
      await runPutParagraph(process.argv[3], process.argv[4], process.argv[5]);
      return;
    case "post-paragraph":
      await runPostParagraph(process.argv[3], process.argv[4], process.argv[5]);
      return;
    case "summary":
      await runSummary(process.argv[3], process.argv[4]);
      return;
    case "audit":
      await runAudit(process.argv[3]);
      return;
    case "serve":
      await serve(await resolveWorkspace(process.env), false);
      return;
    case "mcp":
      await runMcp();
      return;
    default:
      await emit(render({ kind: "error", message: usage }), 1);
  }
}

async function runSetup(args: readonly string[]): Promise<void> {
  const provider = flag(args, "--provider");
  const queueText = flag(args, "--queue-length");
  const fleetText = flag(args, "--fleet-limit");
  const whistleText = flag(args, "--whistle-limit");
  const embeddingText = flag(args, "--embedding-limit");
  const fleetArgs = flagValues(args, "--model-fleet");
  const weightArgs = flagValues(args, "--model-weights");
  if (
    provider === undefined ||
    queueText === undefined ||
    !isCountText(queueText) ||
    (args.includes("--fleet-limit") && !isCountText(fleetText ?? "")) ||
    (args.includes("--whistle-limit") && !isCountText(whistleText ?? "")) ||
    (args.includes("--embedding-limit") && !isCountText(embeddingText ?? "")) ||
    !fleetPairsOk(fleetArgs) ||
    !weightPairsOk(weightArgs)
  ) {
    await emit(render({ kind: "error", message: usage }), 1);
  }
  const fleetLimit = sharedLimit(fleetText, whistleText);
  const modelFleet = modelFleetFrom(fleetArgs);
  const modelWeights = modelWeightsFrom(weightArgs);
  const root = await workspaceArg();
  const alive = await ownerAlive(root);
  const result = await setupWorkspace({
    root,
    provider,
    queueLength: Number(queueText),
    ...(fleetLimit === undefined ? {} : { fleetLimit }),
    ...(modelFleet === undefined ? {} : { modelFleet }),
    ...(modelWeights === undefined ? {} : { modelWeights }),
    ...(embeddingText === undefined ? {} : { embeddingLimit: Number(embeddingText) }),
    ownerAlive: alive,
  });
  await emit(render(publicSetup(result)), result.kind === "ready" ? 0 : 1);
}

async function runStart(args: readonly string[]): Promise<void> {
  const language = flag(args, "--language");
  const audioPath = startPath(args);
  if (
    audioPath === undefined ||
    (args.includes("--language") && (language === undefined || language === ""))
  ) {
    await emit(render({ kind: "error", message: usage }), 1);
  }
  const root = await resolveWorkspace(process.env);
  await ensureOwner(root);
  const text = await callOwner(root, {
    op: "start",
    audioPath,
    ...(language === undefined ? {} : { language }),
  });
  const code = text.includes("\"kind\":\"rejected\"") || text.includes("\"kind\":\"full\"") ? 1 : 0;
  await emit(text, code);
}

async function runCues(args: readonly string[]): Promise<void> {
  const episodeId = args[0];
  if (episodeId === undefined || episodeId === "" || episodeId.startsWith("-")) {
    await emit(render({ kind: "error", message: usage }), 1);
  }
  const limitText = flag(args, "--limit");
  const after = flag(args, "--after");
  const groupId = flag(args, "--group-id");
  if (args.includes("--limit") && (limitText === undefined || !/^-?\d+$/.test(limitText))) {
    await emit(render({ kind: "error", message: usage }), 1);
  }
  if (args.includes("--after") && (after === undefined || after === "")) {
    await emit(render({ kind: "error", message: usage }), 1);
  }
  if (args.includes("--group-id") && (groupId === undefined || groupId === "")) {
    await emit(render({ kind: "error", message: usage }), 1);
  }
  const root = await resolveWorkspace(process.env);
  await ensureOwner(root);
  const text = await callOwner(root, {
    op: "cues",
    episodeId,
    ...(limitText === undefined ? {} : { limit: Number(limitText) }),
    ...(after === undefined ? {} : { after }),
    ...(groupId === undefined ? {} : { groupId }),
    ...(args.includes("--hosts") ? { hosts: true } : {}),
  });
  const code = text.includes("\"kind\":\"rejected\"") || text.includes("\"kind\":\"error\"") ? 1 : 0;
  await emit(text, code);
}

async function runLabelGroups(episodeId: string | undefined, json: string | undefined): Promise<void> {
  if (episodeId === undefined || episodeId === "" || json === undefined || json === "") {
    await emit(render({ kind: "error", message: usage }), 1);
  }
  let groups: unknown;
  try {
    groups = JSON.parse(json);
  } catch {
    await emit(
      render({ kind: "error", message: "label-groups expects a JSON array of { groupId, label }" }),
      1,
    );
  }
  const root = await resolveWorkspace(process.env);
  await ensureOwner(root);
  const text = await callOwner(root, { op: "labelGroups", episodeId, groups });
  const code = text.includes("\"kind\":\"error\"") ? 1 : 0;
  await emit(text, code);
}

async function runStartSummary(episodeId: string | undefined): Promise<void> {
  if (episodeId === undefined || episodeId === "") {
    await emit(render({ kind: "error", message: usage }), 1);
  }
  const root = await resolveWorkspace(process.env);
  await ensureOwner(root);
  const text = await callOwner(root, {
    op: "startSummary",
    episodeId,
  });
  await emit(text, text.includes("\"kind\":\"error\"") ? 1 : 0);
}

async function runSetSummary(
  episodeId: string | undefined,
  summaryId: string | undefined,
  json: string | undefined,
): Promise<void> {
  if (episodeId === undefined || episodeId === "" || summaryId === undefined || summaryId === "") {
    await emit(render({ kind: "error", message: usage }), 1);
  }
  const body = await jsonObject(json, "set-summary expects JSON { summary }");
  const root = await resolveWorkspace(process.env);
  await ensureOwner(root);
  const text = await callOwner(root, {
    op: "setSummary",
    episodeId,
    summaryId,
    summary: body["summary"],
  });
  await emit(text, text.includes("\"kind\":\"error\"") ? 1 : 0);
}

async function runPutParagraph(
  episodeId: string | undefined,
  summaryId: string | undefined,
  json: string | undefined,
): Promise<void> {
  if (episodeId === undefined || episodeId === "" || summaryId === undefined || summaryId === "") {
    await emit(render({ kind: "error", message: usage }), 1);
  }
  const body = await jsonObject(json, "put-paragraph expects a JSON object");
  const root = await resolveWorkspace(process.env);
  await ensureOwner(root);
  const text = await callOwner(root, { op: "putParagraph", episodeId, summaryId, body });
  await emit(text, text.includes("\"kind\":\"error\"") ? 1 : 0);
}

async function runPostParagraph(
  episodeId: string | undefined,
  summaryId: string | undefined,
  json: string | undefined,
): Promise<void> {
  if (episodeId === undefined || episodeId === "" || summaryId === undefined || summaryId === "") {
    await emit(render({ kind: "error", message: usage }), 1);
  }
  const body = await jsonObject(json, "post-paragraph expects a JSON object");
  const root = await resolveWorkspace(process.env);
  await ensureOwner(root);
  const text = await callOwner(root, { op: "postParagraph", episodeId, summaryId, body });
  await emit(text, text.includes("\"kind\":\"error\"") ? 1 : 0);
}

async function runSummary(episodeId: string | undefined, summaryId: string | undefined): Promise<void> {
  if (
    episodeId === undefined ||
    episodeId === "" ||
    summaryId === undefined ||
    summaryId === ""
  ) {
    await emit(render({ kind: "error", message: usage }), 1);
  }
  const root = await resolveWorkspace(process.env);
  await ensureOwner(root);
  const text = await callOwner(root, { op: "summary", episodeId, summaryId });
  await emit(text, text.includes("\"kind\":\"error\"") ? 1 : 0);
}

async function jsonObject(
  json: string | undefined,
  message: string,
): Promise<Record<string, unknown>> {
  if (json === undefined || json === "") {
    await emit(render({ kind: "error", message: usage }), 1);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    await emit(render({ kind: "error", message }), 1);
  }
  const record = asRecord(parsed);
  if (record === undefined) {
    await emit(render({ kind: "error", message }), 1);
  }
  return record;
}

async function runAudit(episodeId: string | undefined): Promise<void> {
  if (episodeId === undefined || episodeId === "") {
    await emit(render({ kind: "error", message: usage }), 1);
  }
  const root = await resolveWorkspace(process.env);
  await ensureOwner(root);
  const text = await callOwner(root, { op: "audit", episodeId });
  await emit(text, text.includes("\"kind\":\"error\"") ? 1 : 0);
}

async function runEpisode(episodeId: string | undefined): Promise<void> {
  if (episodeId === undefined || episodeId === "") {
    await emit(render({ kind: "error", message: usage }), 1);
  }
  const root = await resolveWorkspace(process.env);
  await ensureOwner(root);
  await emit(await callOwner(root, { op: "episode", episodeId }), 0);
}

async function runMcp(): Promise<void> {
  const root = await resolveWorkspace(process.env);
  if (await ownerAlive(root)) {
    await proxyMcp(root);
    return;
  }
  await serve(root, true);
}

async function ensureOwner(root: string): Promise<void> {
  if (await ownerAlive(root)) {
    return;
  }
  const child = spawn(
    process.execPath,
    [...process.execArgv, fileURLToPath(import.meta.url), "serve"],
    { detached: true, stdio: "ignore", env: process.env },
  );
  child.unref();
  await waitForOwner(root);
}

async function waitForOwner(root: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (await ownerAlive(root)) {
      return;
    }
    await delay(50);
  }
  throw new Error("poddrill serve did not start");
}

function publicSetup(result: SetupResult): PublicSetup {
  switch (result.kind) {
    case "ready":
      return {
        kind: "ready",
        provider: result.report.config.provider,
        queueLength: result.report.config.queueLength,
        fleetLimit: result.report.config.fleetLimit,
        embeddingLimit: result.report.config.embeddingLimit,
      };
    case "rejected":
      return {
        kind: "rejected",
        reason: result.reason,
        provider: result.current.provider,
        queueLength: result.current.queueLength,
        fleetLimit: result.current.fleetLimit,
        embeddingLimit: result.current.embeddingLimit,
        message: result.message,
      };
    default: {
      const leftover: never = result;
      throw new Error(`unexpected setup ${JSON.stringify(leftover)}`);
    }
  }
}

function isCountText(text: string): boolean {
  return /^[1-9]\d*$/.test(text);
}

async function workspaceArg(): Promise<string> {
  const configured = process.env["PODDRILL_WORKSPACE"];
  const candidate = resolve(
    configured === undefined || configured === "" ? process.cwd() : configured,
  );
  try {
    return await realpath(candidate);
  } catch (error: unknown) {
    if (errorCode(error) === "ENOENT") {
      return candidate;
    }
    throw error;
  }
}

function startPath(args: readonly string[]): string | undefined {
  const paths: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === undefined) {
      continue;
    }
    if (arg === "--language") {
      index += 1;
      continue;
    }
    paths.push(arg);
  }
  return paths.length === 1 ? paths[0] : undefined;
}

function flag(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index === -1) {
    return undefined;
  }
  return args[index + 1];
}

function flagValues(args: readonly string[], name: string): readonly string[] {
  const values: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] !== name) {
      continue;
    }
    const value = args[index + 1];
    if (value === undefined || value.startsWith("--")) {
      values.push("");
      continue;
    }
    values.push(value);
    index += 1;
  }
  return values;
}

function sharedLimit(fleetText: string | undefined, whistleText: string | undefined): number | undefined {
  if (fleetText !== undefined && whistleText !== undefined && fleetText !== whistleText) {
    throw new Error(`fleet limit ${fleetText} and whistle limit ${whistleText} differ`);
  }
  const chosen = fleetText ?? whistleText;
  if (chosen === undefined) {
    return undefined;
  }
  return Number(chosen);
}

function fleetPairsOk(values: readonly string[]): boolean {
  return values.every((value) => {
    const pair = splitPair(value);
    return pair !== undefined && isCountText(pair.right);
  });
}

function weightPairsOk(values: readonly string[]): boolean {
  return values.every((value) => splitPair(value) !== undefined);
}

function modelFleetFrom(values: readonly string[]): ModelFleet | undefined {
  if (values.length === 0) {
    return undefined;
  }
  const fleet: Partial<Record<ModelId, number>> = {};
  for (const value of values) {
    const pair = splitPair(value);
    if (pair === undefined) {
      throw new Error(usage);
    }
    if (!isModelId(pair.left)) {
      throw new Error(`unknown model ${pair.left}`);
    }
    fleet[pair.left] = Number(pair.right);
  }
  return fleet;
}

function modelWeightsFrom(values: readonly string[]): ModelWeights | undefined {
  if (values.length === 0) {
    return undefined;
  }
  const weights: Partial<Record<ModelId, string>> = {};
  for (const value of values) {
    const pair = splitPair(value);
    if (pair === undefined) {
      throw new Error(usage);
    }
    if (!isModelId(pair.left)) {
      throw new Error(`unknown model ${pair.left}`);
    }
    if (!isAbsolute(pair.right)) {
      throw new Error(`model weights path for ${pair.left} must be absolute, got ${pair.right}`);
    }
    weights[pair.left] = pair.right;
  }
  return weights;
}

function splitPair(text: string): { readonly left: string; readonly right: string } | undefined {
  const index = text.indexOf("=");
  if (index <= 0 || index === text.length - 1) {
    return undefined;
  }
  return { left: text.slice(0, index), right: text.slice(index + 1) };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function emit(text: string, code: number): Promise<never> {
  await new Promise<void>((resolve, reject) => {
    process.stdout.write(text, (error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
  process.exit(code);
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stdout.write(render({ kind: "error", message }), () => {
    process.exit(1);
  });
});
