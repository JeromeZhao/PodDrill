#!/usr/bin/env node

import { spawn } from "node:child_process";
import { realpath } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";

import { clientMain, workspaceSetupCollision } from "./client.ts";
import { asRecord, errorCode, pathExists } from "./disk.ts";
import { embedWeightsPath } from "./embed.ts";
import { isModelId, type ModelFleet, type ModelId, type ModelWeights } from "./models.ts";
import { nodeInstallMessage, nodeMeetsMinimum } from "./node-version.ts";
import { callOwner, ownerAlive, proxyMcp, pythonForOwner, render, serve } from "./owner.ts";
import { readPackageIdentity } from "./package-identity.ts";
import { installPython } from "./python-env.ts";
import { fetchEcapa } from "./weights.ts";
import { defaultWorkspacePath, resolveWorkspace, setupWorkspace, type SetupResult } from "./workspace.ts";

const usage = [
  "usage: poddrill setup --provider <id> --queue-length <n> [--fleet-limit <n>] [--whistle-limit <n>]",
  "[--model-fleet <id>=<count>] [--model-weights <id>=<path>] [--embedding-limit <n>] [--python <path>]",
  "| install-python | fetch-weights | bootstrap [--provider <id>] [--queue-length <n>]",
  "| start <path> [--language <code>] | episode <episodeId> | cues <episodeId> [--limit <n>] [--after <cueId>] [--group-id <id>] [--hosts]",
  "| label-groups <episodeId> <json> | start-summary <episodeId> | set-summary <episodeId> <summaryId> <json>",
  "| put-paragraph <episodeId> <summaryId> <json> | post-paragraph <episodeId> <summaryId> <json> | summary <episodeId> <summaryId> | audit <episodeId>",
  "| serve | stop | mcp [--selftest] | --help | --version",
].join(" ");

type PublicSetup =
  | {
      readonly kind: "ready";
      readonly provider: string;
      readonly queueLength: number;
      readonly fleetLimit: number;
      readonly embeddingLimit: number;
      readonly python?: string;
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
  if (!nodeMeetsMinimum(process.versions.node)) {
    await emit(render({ kind: "error", message: nodeInstallMessage(process.versions.node) }), 1);
  }
  const command = process.argv[2];
  switch (command) {
    case "--help":
    case "-h":
    case "help":
      await emit(helpText(), 0);
    case "--version":
    case "-v":
    case "version":
      await emit(await versionText(), 0);
    case "setup":
      await runSetup(process.argv.slice(3));
      return;
    case "install-python":
      await runInstallPython();
      return;
    case "fetch-weights":
      await runFetchWeights();
      return;
    case "bootstrap":
      await runBootstrap(process.argv.slice(3));
      return;
    case "stop":
      await runStop();
      return;
    case "client": {
      const rendered = await clientMain(process.argv.slice(3), process.env, import.meta.url);
      await emit(rendered.text, rendered.exitCode);
      return;
    }
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
      await runMcp(process.argv.slice(3));
      return;
    default:
      await emit(render({ kind: "error", message: usage }), 1);
  }
}

async function runSetup(args: readonly string[]): Promise<void> {
  const collision = workspaceSetupCollision(args);
  if (collision !== undefined) {
    await emit(render({ kind: "error", message: collision }), 1);
  }
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
  const python = await chosenPython(args);
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
    ...(python === undefined ? {} : { python }),
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

async function runInstallPython(): Promise<void> {
  const installed = await installPython(process.env, import.meta.url);
  await emit(render({ kind: "ready", ...installed }), 0);
}

async function runFetchWeights(): Promise<void> {
  const fetched = await fetchEcapa(embedWeightsPath(process.env));
  await emit(render({ kind: "ready", ...fetched }), 0);
}

async function runBootstrap(args: readonly string[]): Promise<void> {
  const provider = flag(args, "--provider") ?? "localhost";
  const queueText = flag(args, "--queue-length") ?? "4";
  if (!isCountText(queueText) || flag(args, "--provider") === "") {
    await emit(render({ kind: "error", message: usage }), 1);
  }
  const installed = await installPython(process.env, import.meta.url);
  const weights = await fetchEcapa(embedWeightsPath(process.env));
  const root = await workspaceArg();
  const alive = await ownerAlive(root);
  const result = await setupWorkspace({
    root,
    provider,
    queueLength: Number(queueText),
    python: installed.python,
    ownerAlive: alive,
  });
  if (result.kind !== "ready") {
    await emit(render(publicSetup(result)), 1);
  }
  await emit(
    render({
      kind: "ready",
      python: installed.python,
      installer: installed.installer,
      weights,
      setup: publicSetup(result),
    }),
    0,
  );
}

async function runStop(): Promise<void> {
  const root = await resolveWorkspace(process.env);
  if (!(await ownerAlive(root))) {
    await emit(render({ kind: "ready", state: "stopped" }), 0);
  }
  const text = await callOwner(root, { op: "stop" });
  await emit(text, text.includes("\"kind\":\"error\"") ? 1 : 0);
}

async function runMcp(args: readonly string[]): Promise<void> {
  if (args.includes("--selftest")) {
    const root = await resolveWorkspace(process.env);
    const python = await pythonForOwner(process.env, root);
    await emit(
      render({
        kind: "ready",
        execPath: process.execPath,
        script: fileURLToPath(import.meta.url),
        env: {
          PATH: process.env["PATH"] ?? "",
          PODDRILL_PYTHON: python,
          PODDRILL_WORKSPACE: defaultWorkspacePath(process.env),
          PODDRILL_EMBED_WEIGHTS: embedWeightsPath(process.env),
        },
      }),
      0,
    );
  }
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
        ...(result.report.config.python === undefined ? {} : { python: result.report.config.python }),
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
  const candidate = defaultWorkspacePath(process.env);
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

async function chosenPython(args: readonly string[]): Promise<string | undefined> {
  const flagged = flag(args, "--python");
  const fromEnv = process.env["PODDRILL_PYTHON"];
  const flaggedSet = flagged !== undefined && flagged !== "";
  const envSet = fromEnv !== undefined && fromEnv !== "";
  if (!flaggedSet && !envSet) {
    return undefined;
  }
  if (flaggedSet && envSet && flagged !== fromEnv) {
    await emit(
      render({ kind: "error", message: `python ${flagged} and PODDRILL_PYTHON ${fromEnv} differ` }),
      1,
    );
  }
  const chosen = flaggedSet ? flagged : fromEnv;
  if (typeof chosen !== "string" || !isAbsolute(chosen)) {
    await emit(render({ kind: "error", message: `python must be an absolute path, got ${String(chosen)}` }), 1);
  }
  if (typeof chosen !== "string" || !(await pathExists(chosen))) {
    await emit(render({ kind: "error", message: `python interpreter not found at ${String(chosen)}` }), 1);
  }
  if (typeof chosen !== "string") {
    await emit(render({ kind: "error", message: "python must be an absolute path" }), 1);
  }
  return chosen;
}

function helpText(): string {
  const lines = [
    "poddrill transcribes audio, groups voices, and stores a summary.",
    "",
    "Commands:",
    "  setup --provider <id> --queue-length <n> [--fleet-limit <n>] [--embedding-limit <n>]",
    "        [--model-fleet <id>=<count>] [--model-weights <id>=<path>] [--python <path>]",
    "  install-python     create ~/.cache/poddrill/venv and install pinned Python packages",
    "  fetch-weights      download the pinned ECAPA file and check its sha256",
    "  bootstrap [--provider <id>] [--queue-length <n>]",
    "                     install-python, fetch-weights, then setup",
    "  start <path> [--language <code>]",
    "  episode <episodeId>",
    "  cues <episodeId> [--limit <n>] [--after <cueId>] [--group-id <id>] [--hosts]",
    "  label-groups <episodeId> <json>",
    "  start-summary <episodeId>",
    "  set-summary <episodeId> <summaryId> <json>",
    "  put-paragraph <episodeId> <summaryId> <json>",
    "  post-paragraph <episodeId> <summaryId> <json>",
    "  summary <episodeId> <summaryId>",
    "  audit <episodeId>",
    "  serve",
    "  stop               stop the running owner",
    "  mcp [--selftest]",
    "  client doctor|plan|apply",
    "",
    "  --help             show this text",
    "  --version          print the package version",
    "",
    "Providers localhost, grok-bot, and cursor-cloud all run the local Python host on this computer.",
    "Every command uses PODDRILL_WORKSPACE, or ~/poddrill when that variable is unset.",
    "Python is PODDRILL_PYTHON, then the path stored by setup, then ~/.cache/poddrill/venv/bin/python, then python3.",
  ];
  return `${lines.join("\n")}\n`;
}

async function versionText(): Promise<string> {
  const identity = await readPackageIdentity(import.meta.url);
  return `poddrill ${identity.version}\n`;
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
