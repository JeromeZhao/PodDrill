import { execFile, spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { parseDocument } from "yaml";

import { socketPath } from "../../src/owner.ts";
import { episodeIdFromDigest } from "../../src/workspace.ts";

/** `"default"` stops at a terminal transcript. `"live"` also requires labels and a summary. */
export type TranscriptionGoal = "default" | "live";

export interface HarnessRequest {
  readonly goal?: TranscriptionGoal;
  /** Executable path or bare name. Omitted means `"gbot"` on `PATH`. */
  readonly gbotPath?: string;
}

declare const workspacePathBrand: unique symbol;
export type WorkspacePath = string & { readonly [workspacePathBrand]: "WorkspacePath" };

declare const episodeIdBrand: unique symbol;
export type EpisodeId = string & { readonly [episodeIdBrand]: "EpisodeId" };

export const failCodes = [
  "gbot-not-on-path",
  "desktop-not-signed-in",
  "gbot-rejected",
  "another-run-holds-the-lock",
  "roster-ambiguous",
  "bot-not-deleted",
  "timed-out",
  "workspace-mismatch",
  "transcript-failed-unexpectedly",
] as const;

export type FailCode = (typeof failCodes)[number];

export const workspaceProblems = [
  "missing-config",
  "provider-not-localhost",
  "queue-length-not-one",
  "episode-missing",
  "episode-id-mismatch",
  "audio-outside-tree",
] as const;

export type WorkspaceProblem = (typeof workspaceProblems)[number];

export type HarnessReport =
  | {
      readonly kind: "pass-default";
      readonly transcript: "blocked-on-cactus-needle" | "ready";
      readonly episodeId: EpisodeId;
      readonly workspacePath: WorkspacePath;
    }
  | {
      readonly kind: "pass-live";
      readonly episodeId: EpisodeId;
      readonly workspacePath: WorkspacePath;
    }
  | {
      readonly kind: "fail";
      readonly code: "workspace-mismatch";
      readonly problem: WorkspaceProblem;
      readonly workspacePath: WorkspacePath;
    }
  | {
      readonly kind: "fail";
      readonly code: Exclude<FailCode, "workspace-mismatch">;
      readonly workspacePath: WorkspacePath;
    };

export async function runHarness(request?: HarnessRequest): Promise<HarnessReport> {
  const resolved = resolveRequest(request);
  const adopted = await adoptPreviousLease(resolved.gbotPath);
  if (adopted !== "clear") {
    return failReport(adopted, resolved.workspacePath);
  }
  if (!(await desktopSignedIn())) {
    return failReport("desktop-not-signed-in", resolved.workspacePath);
  }
  const before = await listBots(resolved.gbotPath);
  if (before.kind === "fail") {
    return failReport(before.code, resolved.workspacePath);
  }
  await writeLease({ pid: process.pid, beforeCreate: before.names, created: null });
  const requested = freshBotName();
  let createdRaw: GbotRaw;
  try {
    createdRaw = await spawnGbot(resolved.gbotPath, { kind: "bots-create", name: requested });
  } catch (error: unknown) {
    if (isEnoent(error)) {
      return failReport("gbot-not-on-path", resolved.workspacePath);
    }
    throw error;
  }
  if (createdRaw.exitCode !== 0) {
    await removeLease();
    return failReport("roster-ambiguous", resolved.workspacePath);
  }
  const after = await listBots(resolved.gbotPath);
  if (after.kind === "fail") {
    return failReport(after.code, resolved.workspacePath);
  }
  const mint = mintCreatedBot(before.names, after.names);
  if (mint.kind !== "one" || mint.name !== requested) {
    await removeLease();
    return failReport("roster-ambiguous", resolved.workspacePath);
  }
  const bot = mint.name;
  await writeLease({ pid: process.pid, beforeCreate: before.names, created: bot });
  const skilled = await ensureSkill(resolved);
  if (skilled !== "ok") {
    return release(resolved, bot, failReport(skilled, resolved.workspacePath));
  }
  await stopHarnessOwner(resolved.workspacePath);
  await replaceWorkspace(resolved.workspacePath);
  await writeFixtureWav(resolved.fixtureWav);
  const sent = await sendPrompt(resolved, bot);
  if (sent !== "ok") {
    return release(resolved, bot, failReport(sent, resolved.workspacePath));
  }
  const driven = await driveUntilTerminal(resolved, bot);
  return release(resolved, bot, reportFromDrive(driven, resolved.workspacePath));
}

/**
 * CLI shell. `--live` sets the goal. `--gbot <path>` sets the executable.
 * Any other argument returns exit 2 and does not call `gbot`.
 * Exit 0 is a pass variant. Exit 1 is a fail variant.
 * Stdout is `JSON.stringify` of the report and nothing else.
 */
export async function runFromArgv(argv: readonly string[]): Promise<number> {
  const parsed = parseArgv(argv);
  if (parsed === "bad") {
    return 2;
  }
  const report = await runHarness(parsed);
  process.stdout.write(JSON.stringify(report));
  return report.kind === "fail" ? 1 : 0;
}

declare const botNameBrand: unique symbol;
type BotName = string & { readonly [botNameBrand]: "BotName" };

declare const harnessBotBrand: unique symbol;
type HarnessBotName = BotName & { readonly [harnessBotBrand]: "HarnessBotName" };

declare const threadCursorBrand: unique symbol;
type ThreadCursor = string & { readonly [threadCursorBrand]: "ThreadCursor" };

declare const taskPromptBrand: unique symbol;
type TaskPrompt = string & { readonly [taskPromptBrand]: "TaskPrompt" };

declare const skillDirBrand: unique symbol;
type SkillDir = string & { readonly [skillDirBrand]: "SkillDir" };

declare const fixtureWavBrand: unique symbol;
type FixtureWav = string & { readonly [fixtureWavBrand]: "FixtureWav" };

declare const gbotExecutableBrand: unique symbol;
type GbotExecutable = string & { readonly [gbotExecutableBrand]: "GbotExecutable" };

interface ResolvedRequest {
  readonly goal: TranscriptionGoal;
  readonly gbotPath: GbotExecutable;
  readonly skillDir: SkillDir;
  readonly workspacePath: WorkspacePath;
  readonly fixtureWav: FixtureWav;
}

interface Lease {
  readonly pid: number;
  readonly beforeCreate: readonly BotName[];
  readonly created: HarnessBotName | null;
}

type Mint =
  | { readonly kind: "one"; readonly name: HarnessBotName }
  | { readonly kind: "none" }
  | { readonly kind: "ambiguous" };

interface ThreadPulse {
  readonly cursor: ThreadCursor;
  readonly entryCount: number;
}

interface TaskCard {
  readonly goal: TranscriptionGoal;
  readonly workspacePath: WorkspacePath;
  readonly fixtureWav: FixtureWav;
  readonly skillDir: SkillDir;
}

type TranscriptFiles =
  | { readonly kind: "ready" }
  | { readonly kind: "failed"; readonly message: string }
  | { readonly kind: "pending" };

interface LabelGroup {
  readonly groupId: string;
  readonly label: string;
}

interface SummaryDocument {
  readonly version: 1;
  readonly episodeId: EpisodeId;
  readonly summary: string;
  readonly paragraphs: readonly unknown[];
}

interface EpisodeFiles {
  readonly episodeId: EpisodeId;
  readonly sha256Hex: string;
  readonly sourceBytesMatchSha: boolean;
  readonly transcript: TranscriptFiles;
  readonly embedding: TranscriptFiles;
  readonly labels: readonly LabelGroup[] | "missing" | "unreadable";
  readonly summaries: readonly SummaryDocument[];
}

interface WorkspaceSnapshot {
  readonly workspacePath: WorkspacePath;
  readonly outsideSkillGitTree: boolean;
  readonly provider: string | null;
  readonly queueLength: number | null;
  readonly configState: "missing" | "unreadable" | "ready";
  readonly episodeCount: number;
  readonly sourceInsideWorkspace: boolean;
  readonly episode: EpisodeFiles | null;
}

type WorkspaceScore =
  | {
      readonly kind: "pass-default";
      readonly transcript: "blocked-on-cactus-needle" | "ready";
      readonly episodeId: EpisodeId;
    }
  | { readonly kind: "pass-live"; readonly episodeId: EpisodeId }
  | { readonly kind: "pending" }
  | { readonly kind: "mismatch"; readonly problem: WorkspaceProblem }
  | { readonly kind: "transcript-failed-unexpectedly" };

const observedPodDrill = {
  configFile: "poddrill.json",
  episodeFile: "episode.json",
  transcriptOutput: "transcript/transcript.vtt",
  transcriptFailed: "transcript/failed.json",
  embeddingOutput: "embedding/embedding.json",
  labelsFile: "labels.json",
  summariesDir: "summaries",
  cactusNeedleMessage:
    "mac provider requires cactus-needle, which is not installed in this process",
} as const;

type ObservedPodDrill = typeof observedPodDrill;

type DriveResult =
  | Exclude<WorkspaceScore, { readonly kind: "pending" }>
  | { readonly kind: "timed-out" };

type GbotArgv =
  | { readonly kind: "bots-list" }
  | { readonly kind: "bots-create"; readonly name: string }
  | { readonly kind: "bots-delete"; readonly name: HarnessBotName }
  | { readonly kind: "skills-list" }
  | { readonly kind: "skills-add"; readonly dir: SkillDir }
  | { readonly kind: "send"; readonly name: HarnessBotName; readonly message: TaskPrompt }
  | {
      readonly kind: "thread";
      readonly name: HarnessBotName;
      readonly after: ThreadCursor | null;
    };

interface GbotRaw {
  readonly exitCode: number | null;
  readonly stdout: string;
}

type Listed =
  | { readonly kind: "names"; readonly names: readonly BotName[] }
  | { readonly kind: "fail"; readonly code: "gbot-not-on-path" | "gbot-rejected" };

type SpawnFailure = "ok" | "gbot-not-on-path" | "gbot-rejected";

const POLL_MS = 5_000;

const yamlParseOptions = {
  schema: "core" as const,
  uniqueKeys: true as const,
  maxAliasCount: 0,
};

function resolveRequest(request: HarnessRequest | undefined): ResolvedRequest {
  const goal = request === undefined || request.goal === undefined ? "default" : request.goal;
  const gbotText =
    request === undefined || request.gbotPath === undefined || request.gbotPath === ""
      ? "gbot"
      : request.gbotPath;
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  const workspacePath = join(tmpdir(), "poddrill-harness-workspace");
  if (!isAbsolute(workspacePath)) {
    throw new Error("harness workspace path is not absolute");
  }
  return {
    goal,
    gbotPath: asGbotExecutable(gbotText),
    skillDir: asSkillDir(join(root, ".agents", "skills", "poddrill")),
    workspacePath: asWorkspacePath(workspacePath),
    fixtureWav: asFixtureWav(join(tmpdir(), "poddrill-harness-fixture.wav")),
  };
}

function parseRoster(stdout: string): readonly BotName[] | "unreadable" {
  const value = parseJson(stdout);
  if (value === undefined) {
    return "unreadable";
  }
  const list = rosterList(value);
  if (list === undefined) {
    return "unreadable";
  }
  const names: BotName[] = [];
  for (const item of list) {
    const name = rosterItemName(item);
    if (name === undefined) {
      return "unreadable";
    }
    names.push(asBotName(name));
  }
  return names;
}

function parseLease(text: string): Lease | "unreadable" {
  const value = parseJson(text);
  if (!isRecord(value)) {
    return "unreadable";
  }
  const pid = value["pid"];
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) {
    return "unreadable";
  }
  const beforeRaw = value["beforeCreate"];
  if (!Array.isArray(beforeRaw)) {
    return "unreadable";
  }
  const beforeCreate: BotName[] = [];
  for (const item of beforeRaw) {
    if (typeof item !== "string" || item === "") {
      return "unreadable";
    }
    beforeCreate.push(asBotName(item));
  }
  const createdRaw = value["created"];
  if (createdRaw === null) {
    return { pid, beforeCreate, created: null };
  }
  if (typeof createdRaw !== "string" || createdRaw === "") {
    return "unreadable";
  }
  if (beforeCreate.some((name) => name === createdRaw)) {
    return "unreadable";
  }
  return { pid, beforeCreate, created: asHarnessBotName(asBotName(createdRaw)) };
}

function parseSkillList(stdout: string): readonly SkillDir[] | "unreadable" {
  const value = parseJson(stdout);
  if (value === undefined) {
    return "unreadable";
  }
  const list = skillList(value);
  if (list === undefined) {
    return "unreadable";
  }
  const dirs: SkillDir[] = [];
  for (const item of list) {
    const text = skillItemText(item);
    if (text === undefined) {
      return "unreadable";
    }
    dirs.push(asSkillDir(text));
  }
  return dirs;
}

function mintCreatedBot(before: readonly BotName[], after: readonly BotName[]): Mint {
  const beforeSet = new Set<string>(before);
  const created: BotName[] = [];
  const seen = new Set<string>();
  for (const name of after) {
    if (beforeSet.has(name) || seen.has(name)) {
      continue;
    }
    seen.add(name);
    created.push(name);
  }
  if (created.length === 0) {
    return { kind: "none" };
  }
  const only = created[0];
  if (created.length > 1 || only === undefined) {
    return { kind: "ambiguous" };
  }
  return { kind: "one", name: asHarnessBotName(only) };
}

function parseThreadPulse(stdout: string): ThreadPulse | "unreadable" {
  const value = parseJson(stdout);
  if (!isRecord(value)) {
    return "unreadable";
  }
  const cursorText = stringField(value, "cursor") ?? stringField(value, "after");
  if (cursorText === undefined) {
    return "unreadable";
  }
  const entryCount = entryCountField(value);
  if (entryCount === undefined) {
    return "unreadable";
  }
  return { cursor: asThreadCursor(cursorText), entryCount };
}

function gbotArgv(command: GbotArgv): readonly string[] {
  switch (command.kind) {
    case "bots-list":
      return ["bots", "list", "--json"];
    case "bots-create":
      return ["bots", "create", "--name", command.name, "--json"];
    case "bots-delete":
      return ["bots", "delete", command.name, "--json"];
    case "skills-list":
      return ["skills", "list", "--json"];
    case "skills-add":
      return ["skills", "add", command.dir, "--json"];
    case "send":
      return ["send", command.name, command.message, "--json"];
    case "thread":
      if (command.after === null) {
        return ["thread", command.name, "--json"];
      }
      return ["thread", command.name, "--after", command.after, "--json"];
    default: {
      const neverCommand: never = command;
      return neverCommand;
    }
  }
}

function spawnGbot(executable: GbotExecutable, command: GbotArgv): Promise<GbotRaw> {
  const argv = gbotArgv(command);
  return new Promise((resolvePromise, reject) => {
    const child = spawn(executable, [...argv], { stdio: ["ignore", "pipe", "ignore"] });
    const stdout = child.stdout;
    if (stdout === null) {
      reject(new Error("gbot stdout is unavailable"));
      return;
    }
    const chunks: Buffer[] = [];
    let settled = false;
    stdout.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
    });
    child.on("error", (error: Error) => {
      if (settled) {
        return;
      }
      settled = true;
      reject(error);
    });
    child.on("close", (exitCode: number | null) => {
      if (settled) {
        return;
      }
      settled = true;
      resolvePromise({ exitCode, stdout: Buffer.concat(chunks).toString("utf8") });
    });
  });
}

function episodeIdFromAudio(bytes: Uint8Array): EpisodeId {
  const sha256Hex = createHash("sha256").update(bytes).digest("hex");
  return brandEpisodeId(episodeIdFromDigest(sha256Hex));
}

function harnessSocketPath(workspacePath: WorkspacePath): string {
  return socketPath(workspacePath);
}

async function stopHarnessOwner(workspacePath: WorkspacePath): Promise<void> {
  const sock = harnessSocketPath(workspacePath);
  const pids = await listenerPids(sock);
  for (const pid of pids) {
    if (pid === process.pid) {
      continue;
    }
    try {
      process.kill(pid, "SIGTERM");
    } catch (error: unknown) {
      if (!isRecord(error) || error["code"] !== "ESRCH") {
        throw error;
      }
    }
  }
  await rm(sock, { force: true }).catch(() => undefined);
}

async function writeFixtureWav(path: FixtureWav): Promise<void> {
  const samples = 16;
  const dataSize = samples * 2;
  const buffer = Buffer.alloc(44 + dataSize);
  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write("WAVE", 8);
  buffer.write("fmt ", 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(16_000, 24);
  buffer.writeUInt32LE(32_000, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36);
  buffer.writeUInt32LE(dataSize, 40);
  await writeFile(path, buffer);
}

function taskPrompt(card: TaskCard): TaskPrompt {
  const cli = join(card.skillDir, "..", "..", "..", "src", "cli.ts");
  const setup = [
    `Set PODDRILL_WORKSPACE to ${card.workspacePath}.`,
    `Run node ${cli} setup --provider localhost --queue-length 1.`,
  ];
  switch (card.goal) {
    case "default":
      return asTaskPrompt(
        [
          ...setup,
          `Copy ${card.fixtureWav} into ${card.workspacePath}/audio/ as a 16 kHz mono PCM wav.`,
          `Run node ${cli} start on that file.`,
          `Poll node ${cli} episode until the transcript is ready or failed, then stop.`,
          "Do not label speakers.",
          "Do not write a summary.",
        ].join("\n"),
      );
    case "live":
      return asTaskPrompt(
        [
          ...setup,
          "The audio is the All-In episode published 10 Oct 2026.",
          "Its enclosure is https://dts.podtrac.com/redirect.mp3/traffic.libsyn.com/secure/allinchamathjason/ALLIN-E292_Ch.mp3?dest-id=1928300",
          "The feed lists 134265006 bytes.",
          `Download that enclosure with node ${join(card.skillDir, "scripts", "fetch-audio.mjs")} to an mp3 path outside the skill git tree and outside ${card.workspacePath}/audio/.`,
          "Pass 134265006 as the expected byte length.",
          `Convert it with ffmpeg to a 16-bit PCM mono 16 kHz wav under ${card.workspacePath}/audio/.`,
          `Run node ${cli} start on that wav with --language en.`,
          "After the transcript and the embedding are ready, assign speakers.",
          "Write one summary of the topics, the perspectives, and who held them.",
          `Paragraphs and the episode summary follow Orwell's rules in ${join(card.skillDir, "references", "orwell.md")}.`,
          `Use node ${cli} start-summary, set-summary, and post-paragraph.`,
          "Do not write the YAML file yourself.",
        ].join("\n"),
      );
    default: {
      const neverGoal: never = card.goal;
      return neverGoal;
    }
  }
}

async function readWorkspace(workspacePath: WorkspacePath, skillDir: SkillDir): Promise<WorkspaceSnapshot> {
  const layout: ObservedPodDrill = observedPodDrill;
  const config = await readConfigFile(join(workspacePath, layout.configFile));
  const loaded = await readEpisode(workspacePath, layout);
  return {
    workspacePath,
    outsideSkillGitTree: isOutsideGitTree(workspacePath, skillDir),
    provider: config === "missing" || config === "unreadable" ? null : config.provider,
    queueLength: config === "missing" || config === "unreadable" ? null : config.queueLength,
    configState: config === "missing" || config === "unreadable" ? config : "ready",
    episodeCount: loaded.count,
    sourceInsideWorkspace: loaded.sourceInsideWorkspace,
    episode: loaded.episode,
  };
}

function scoreWorkspace(snapshot: WorkspaceSnapshot, goal: TranscriptionGoal): WorkspaceScore {
  if (!snapshot.outsideSkillGitTree || !snapshot.sourceInsideWorkspace) {
    return { kind: "mismatch", problem: "audio-outside-tree" };
  }
  if (snapshot.configState === "missing") {
    return { kind: "pending" };
  }
  if (snapshot.configState === "unreadable") {
    return { kind: "mismatch", problem: "missing-config" };
  }
  if (snapshot.provider !== "localhost") {
    return { kind: "mismatch", problem: "provider-not-localhost" };
  }
  if (snapshot.queueLength !== 1) {
    return { kind: "mismatch", problem: "queue-length-not-one" };
  }
  if (snapshot.episodeCount === 0) {
    return { kind: "pending" };
  }
  if (snapshot.episode === null) {
    return {
      kind: "mismatch",
      problem: snapshot.episodeCount > 1 ? "episode-id-mismatch" : "episode-missing",
    };
  }
  if (!snapshot.episode.sourceBytesMatchSha) {
    return { kind: "mismatch", problem: "episode-id-mismatch" };
  }
  return scoreArtifacts(snapshot.episode, goal);
}

async function driveUntilTerminal(request: ResolvedRequest, bot: HarnessBotName): Promise<DriveResult> {
  const deadline = Date.now() + deadlineMs(request.goal);
  let cursor: ThreadCursor | null = null;
  for (;;) {
    const snapshot = await readWorkspace(request.workspacePath, request.skillDir);
    const score = scoreWorkspace(snapshot, request.goal);
    if (score.kind !== "pending") {
      return score;
    }
    if (Date.now() >= deadline) {
      return { kind: "timed-out" };
    }
    cursor = await refreshThread(request.gbotPath, bot, cursor);
    await delay(POLL_MS);
  }
}

function launchedAsCli(): boolean {
  const entry = process.argv[1];
  if (entry === undefined || entry === "") {
    return false;
  }
  return import.meta.url === pathToFileURL(entry).href;
}

function parseArgv(argv: readonly string[]): HarnessRequest | "bad" {
  let goal: TranscriptionGoal | undefined;
  let gbotPath: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--live") {
      goal = "live";
      continue;
    }
    if (arg === "--gbot") {
      const next = argv[index + 1];
      if (next === undefined || next === "" || next.startsWith("--")) {
        return "bad";
      }
      gbotPath = next;
      index += 1;
      continue;
    }
    return "bad";
  }
  return { goal, gbotPath };
}

function failReport(
  code: Exclude<FailCode, "workspace-mismatch">,
  workspacePath: WorkspacePath,
): HarnessReport {
  return { kind: "fail", code, workspacePath };
}

function reportFromDrive(result: DriveResult, workspacePath: WorkspacePath): HarnessReport {
  switch (result.kind) {
    case "pass-default":
      return {
        kind: "pass-default",
        transcript: result.transcript,
        episodeId: result.episodeId,
        workspacePath,
      };
    case "pass-live":
      return { kind: "pass-live", episodeId: result.episodeId, workspacePath };
    case "mismatch":
      return {
        kind: "fail",
        code: "workspace-mismatch",
        problem: result.problem,
        workspacePath,
      };
    case "transcript-failed-unexpectedly":
      return { kind: "fail", code: "transcript-failed-unexpectedly", workspacePath };
    case "timed-out":
      return { kind: "fail", code: "timed-out", workspacePath };
    default: {
      const neverResult: never = result;
      return neverResult;
    }
  }
}

async function adoptPreviousLease(
  gbotPath: GbotExecutable,
): Promise<"clear" | Exclude<FailCode, "workspace-mismatch">> {
  const text = await readLeaseText();
  if (text === "absent") {
    return "clear";
  }
  const lease = parseLease(text);
  if (lease === "unreadable") {
    return "another-run-holds-the-lock";
  }
  if (pidAlive(lease.pid) && lease.pid !== process.pid) {
    return "another-run-holds-the-lock";
  }
  const listed = await listBots(gbotPath);
  if (listed.kind === "fail") {
    return listed.code;
  }
  const target = recoverableName(lease, listed.names);
  if (target === "ambiguous") {
    await removeLease();
    return "roster-ambiguous";
  }
  if (target !== "none") {
    const removed = await deleteOwned(gbotPath, target);
    if (removed !== "deleted") {
      return "bot-not-deleted";
    }
  }
  await removeLease();
  return "clear";
}

function recoverableName(
  lease: Lease,
  roster: readonly BotName[],
): HarnessBotName | "none" | "ambiguous" {
  if (lease.created !== null) {
    return roster.some((name) => name === lease.created) ? lease.created : "none";
  }
  const mint = mintCreatedBot(lease.beforeCreate, roster);
  switch (mint.kind) {
    case "one":
      return mint.name;
    case "none":
      return "none";
    case "ambiguous":
      return "ambiguous";
    default: {
      const neverMint: never = mint;
      return neverMint;
    }
  }
}

async function release(
  resolved: ResolvedRequest,
  bot: HarnessBotName,
  report: HarnessReport,
): Promise<HarnessReport> {
  const removed = await deleteOwned(resolved.gbotPath, bot);
  await stopHarnessOwner(resolved.workspacePath);
  if (removed !== "deleted") {
    return failReport("bot-not-deleted", resolved.workspacePath);
  }
  await removeLease();
  return report;
}

async function ensureSkill(resolved: ResolvedRequest): Promise<SpawnFailure> {
  const listed = await spawnChecked(resolved.gbotPath, { kind: "skills-list" });
  if (listed.kind === "fail") {
    return listed.code;
  }
  const skills = parseSkillList(listed.raw.stdout);
  if (skills === "unreadable" || listed.raw.exitCode !== 0) {
    return "gbot-rejected";
  }
  if (skillPresent(skills, resolved.skillDir)) {
    return "ok";
  }
  const added = await spawnChecked(resolved.gbotPath, { kind: "skills-add", dir: resolved.skillDir });
  if (added.kind === "fail") {
    return added.code;
  }
  if (added.raw.exitCode !== 0) {
    return "gbot-rejected";
  }
  return "ok";
}

async function sendPrompt(resolved: ResolvedRequest, bot: HarnessBotName): Promise<SpawnFailure> {
  const sent = await spawnChecked(resolved.gbotPath, {
    kind: "send",
    name: bot,
    message: taskPrompt({
      goal: resolved.goal,
      workspacePath: resolved.workspacePath,
      fixtureWav: resolved.fixtureWav,
      skillDir: resolved.skillDir,
    }),
  });
  if (sent.kind === "fail") {
    return sent.code;
  }
  if (sent.raw.exitCode !== 0) {
    return "gbot-rejected";
  }
  return "ok";
}

async function listBots(executable: GbotExecutable): Promise<Listed> {
  const listed = await spawnChecked(executable, { kind: "bots-list" });
  if (listed.kind === "fail") {
    return listed;
  }
  if (listed.raw.exitCode !== 0) {
    return { kind: "fail", code: "gbot-rejected" };
  }
  const names = parseRoster(listed.raw.stdout);
  if (names === "unreadable") {
    return { kind: "fail", code: "gbot-rejected" };
  }
  return { kind: "names", names };
}

async function deleteOwned(
  executable: GbotExecutable,
  name: HarnessBotName,
): Promise<"deleted" | "kept"> {
  const deleted = await spawnChecked(executable, { kind: "bots-delete", name });
  if (deleted.kind === "fail") {
    return "kept";
  }
  const listed = await listBots(executable);
  if (listed.kind === "fail") {
    return "kept";
  }
  return listed.names.some((entry) => entry === name) ? "kept" : "deleted";
}

async function spawnChecked(
  executable: GbotExecutable,
  command: GbotArgv,
): Promise<{ readonly kind: "raw"; readonly raw: GbotRaw } | { readonly kind: "fail"; readonly code: "gbot-not-on-path" }> {
  try {
    const raw = await spawnGbot(executable, command);
    return { kind: "raw", raw };
  } catch (error: unknown) {
    if (isEnoent(error)) {
      return { kind: "fail", code: "gbot-not-on-path" };
    }
    throw error;
  }
}

async function refreshThread(
  executable: GbotExecutable,
  bot: HarnessBotName,
  cursor: ThreadCursor | null,
): Promise<ThreadCursor | null> {
  try {
    const raw = await spawnGbot(executable, { kind: "thread", name: bot, after: cursor });
    if (raw.exitCode !== 0) {
      return cursor;
    }
    const pulse = parseThreadPulse(raw.stdout);
    if (pulse === "unreadable") {
      return cursor;
    }
    return pulse.cursor;
  } catch {
    return cursor;
  }
}

function skillPresent(listed: readonly SkillDir[], skillDir: SkillDir): boolean {
  return listed.some((entry) => entry === skillDir || entry === "poddrill");
}

function deadlineMs(goal: TranscriptionGoal): number {
  switch (goal) {
    case "default":
      return 3 * 60 * 1000;
    case "live":
      return 6 * 60 * 60 * 1000;
    default: {
      const neverGoal: never = goal;
      return neverGoal;
    }
  }
}

function scoreArtifacts(episode: EpisodeFiles, goal: TranscriptionGoal): WorkspaceScore {
  const transcript = episode.transcript;
  if (transcript.kind === "pending") {
    return { kind: "pending" };
  }
  if (transcript.kind === "failed") {
    if (goal === "default" && isCactusNeedle(transcript.message)) {
      return {
        kind: "pass-default",
        transcript: "blocked-on-cactus-needle",
        episodeId: episode.episodeId,
      };
    }
    return { kind: "transcript-failed-unexpectedly" };
  }
  if (transcript.kind !== "ready") {
    const neverTranscript: never = transcript;
    return neverTranscript;
  }
  switch (goal) {
    case "default":
      return { kind: "pass-default", transcript: "ready", episodeId: episode.episodeId };
    case "live":
      return scoreLive(episode);
    default: {
      const neverGoal: never = goal;
      return neverGoal;
    }
  }
}

function scoreLive(episode: EpisodeFiles): WorkspaceScore {
  const embedding = episode.embedding;
  if (embedding.kind === "pending") {
    return { kind: "pending" };
  }
  if (embedding.kind === "failed") {
    return { kind: "transcript-failed-unexpectedly" };
  }
  if (embedding.kind !== "ready") {
    const neverEmbedding: never = embedding;
    return neverEmbedding;
  }
  if (episode.labels === "missing" || episode.labels === "unreadable" || episode.labels.length === 0) {
    return { kind: "pending" };
  }
  if (episode.summaries.length !== 1) {
    return { kind: "pending" };
  }
  return { kind: "pass-live", episodeId: episode.episodeId };
}

function isCactusNeedle(message: string): boolean {
  return (
    message === observedPodDrill.cactusNeedleMessage ||
    message.includes("No module named 'needle'") ||
    message.includes("cactus-needle")
  );
}

async function desktopSignedIn(): Promise<boolean> {
  const path = join(homedir(), "Library", "Application Support", "Grok Bot", "desktop-status.json");
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    return false;
  }
  const value = parseJson(text);
  return isRecord(value) && value["signedIn"] === true;
}

function leaseFile(): string {
  return join(tmpdir(), "poddrill-harness-lease.json");
}

async function readLeaseText(): Promise<string | "absent"> {
  try {
    return await readFile(leaseFile(), "utf8");
  } catch (error: unknown) {
    if (isEnoent(error)) {
      return "absent";
    }
    throw error;
  }
}

async function writeLease(lease: Lease): Promise<void> {
  const path = leaseFile();
  const temp = `${path}.${randomBytes(4).toString("hex")}.tmp`;
  await writeFile(
    temp,
    `${JSON.stringify({ pid: lease.pid, beforeCreate: lease.beforeCreate, created: lease.created })}\n`,
  );
  await rename(temp, path);
}

async function removeLease(): Promise<void> {
  await rm(leaseFile(), { force: true });
}

function freshBotName(): string {
  return `pwh-${randomBytes(4).toString("hex")}`;
}

function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: unknown) {
    return isRecord(error) && error["code"] === "EPERM";
  }
}

async function replaceWorkspace(workspacePath: WorkspacePath): Promise<void> {
  await rm(workspacePath, { recursive: true, force: true });
  await mkdir(workspacePath, { recursive: true });
}

async function listenerPids(sock: string): Promise<readonly number[]> {
  return new Promise((resolvePromise) => {
    execFile("lsof", ["-t", sock], { encoding: "utf8" }, (error, stdout) => {
      if (error !== null && isEnoent(error)) {
        resolvePromise([]);
        return;
      }
      resolvePromise(parsePids(stdout));
    });
  });
}

function parsePids(text: string): readonly number[] {
  const pids: number[] = [];
  for (const line of text.split("\n")) {
    if (line === "") {
      continue;
    }
    const pid = Number(line);
    if (!Number.isInteger(pid) || pid <= 0) {
      continue;
    }
    pids.push(pid);
  }
  return pids;
}

function isOutsideGitTree(workspacePath: WorkspacePath, skillDir: SkillDir): boolean {
  const repoRoot = resolve(skillDir, "../../..");
  const fromRoot = relative(repoRoot, workspacePath);
  return fromRoot.startsWith("..") || isAbsolute(fromRoot);
}

async function readConfigFile(
  path: string,
): Promise<"missing" | "unreadable" | { readonly provider: string; readonly queueLength: number }> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error: unknown) {
    if (isEnoent(error)) {
      return "missing";
    }
    throw error;
  }
  const value = parseJson(text);
  if (!isRecord(value)) {
    return "unreadable";
  }
  const provider = value["provider"];
  const queueLength = value["queueLength"];
  if (typeof provider !== "string" || typeof queueLength !== "number" || !Number.isFinite(queueLength)) {
    return "unreadable";
  }
  return { provider, queueLength };
}

async function readEpisode(
  workspacePath: WorkspacePath,
  layout: ObservedPodDrill,
): Promise<{
  readonly count: number;
  readonly sourceInsideWorkspace: boolean;
  readonly episode: EpisodeFiles | null;
}> {
  const episodesDir = join(workspacePath, "episodes");
  let names: string[];
  try {
    names = await readdir(episodesDir);
  } catch (error: unknown) {
    if (isEnoent(error)) {
      return { count: 0, sourceInsideWorkspace: true, episode: null };
    }
    throw error;
  }
  const dirs: string[] = [];
  for (const name of names) {
    if (name.startsWith(".")) {
      continue;
    }
    const dir = join(episodesDir, name);
    try {
      const info = await stat(dir);
      if (info.isDirectory()) {
        dirs.push(name);
      }
    } catch (error: unknown) {
      if (isEnoent(error)) {
        continue;
      }
      throw error;
    }
  }
  if (dirs.length !== 1) {
    return { count: dirs.length, sourceInsideWorkspace: true, episode: null };
  }
  const dirName = dirs[0];
  if (dirName === undefined) {
    return { count: 0, sourceInsideWorkspace: true, episode: null };
  }
  const episodeDir = join(episodesDir, dirName);
  const manifest = parseManifest(parseJson(await readText(join(episodeDir, layout.episodeFile))));
  if (manifest === undefined || manifest.episodeId !== dirName) {
    return { count: 1, sourceInsideWorkspace: true, episode: null };
  }
  const sourcePath = join(episodeDir, manifest.sourceFile);
  const sourceInsideWorkspace = pathInside(workspacePath, sourcePath);
  const hashed = await hashSource(sourcePath);
  const episodeId = brandEpisodeId(manifest.episodeId);
  const sourceBytesMatchSha =
    hashed !== undefined && hashed.sha256Hex === manifest.sha256 && hashed.episodeId === episodeId;
  const transcript = await readArtifact(episodeDir, "transcript", "transcript.vtt");
  const embedding = await readArtifact(episodeDir, "embedding", "embedding.json");
  const labels = await readLabels(join(episodeDir, layout.labelsFile));
  const summaries = await readSummaries(join(episodeDir, layout.summariesDir), episodeId);
  return {
    count: 1,
    sourceInsideWorkspace,
    episode: {
      episodeId,
      sha256Hex: manifest.sha256,
      sourceBytesMatchSha,
      transcript,
      embedding,
      labels,
      summaries,
    },
  };
}

async function readArtifact(episodeDir: string, kind: string, outputName: string): Promise<TranscriptFiles> {
  const dir = join(episodeDir, kind);
  if (await fileExists(join(dir, outputName))) {
    return { kind: "ready" };
  }
  const failedPath = join(dir, "failed.json");
  if (!(await fileExists(failedPath))) {
    return { kind: "pending" };
  }
  const value = parseJson(await readText(failedPath));
  if (!isRecord(value) || typeof value["message"] !== "string") {
    return { kind: "failed", message: "failed.json is unreadable" };
  }
  return { kind: "failed", message: value["message"] };
}

async function readLabels(path: string): Promise<readonly LabelGroup[] | "missing" | "unreadable"> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error: unknown) {
    if (isEnoent(error)) {
      return "missing";
    }
    throw error;
  }
  const value = parseJson(text);
  const list = labelList(value);
  if (list === undefined) {
    return "unreadable";
  }
  const groups: LabelGroup[] = [];
  for (const item of list) {
    if (!isRecord(item)) {
      return "unreadable";
    }
    const groupId = item["groupId"];
    const label = item["label"];
    if (typeof groupId !== "string" || groupId === "" || typeof label !== "string" || label === "") {
      return "unreadable";
    }
    groups.push({ groupId, label });
  }
  return groups;
}

async function readSummaries(dir: string, episodeId: EpisodeId): Promise<readonly SummaryDocument[]> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch (error: unknown) {
    if (isEnoent(error)) {
      return [];
    }
    throw error;
  }
  const found: SummaryDocument[] = [];
  for (const name of names) {
    if (!name.endsWith(".yaml")) {
      continue;
    }
    const text = await readText(join(dir, name));
    const document = qualifySummary(readYaml(text), episodeId);
    if (document !== undefined) {
      found.push(document);
    }
  }
  return found;
}

function qualifySummary(value: unknown, episodeId: EpisodeId): SummaryDocument | undefined {
  if (!isRecord(value) || value["version"] !== 1 || value["episodeId"] !== episodeId) {
    return undefined;
  }
  const summary = value["summary"];
  const paragraphs = value["paragraphs"];
  if (typeof summary !== "string" || summary === "" || !Array.isArray(paragraphs) || paragraphs.length === 0) {
    return undefined;
  }
  return {
    version: 1,
    episodeId,
    summary,
    paragraphs,
  };
}

function readYaml(text: string): unknown {
  let document: ReturnType<typeof parseDocument>;
  try {
    document = parseDocument(text, yamlParseOptions);
  } catch {
    return undefined;
  }
  if (document.errors.length > 0 || document.warnings.length > 0) {
    return undefined;
  }
  try {
    const value: unknown = document.toJS({ maxAliasCount: 0 });
    return value;
  } catch {
    return undefined;
  }
}

function parseManifest(
  value: unknown,
): { readonly episodeId: string; readonly sha256: string; readonly sourceFile: string } | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const episodeId = value["episodeId"];
  const sha256 = value["sha256"];
  const sourceFile = value["sourceFile"];
  if (
    typeof episodeId !== "string" ||
    !/^ep_[0-9a-f]{16}$/.test(episodeId) ||
    typeof sha256 !== "string" ||
    !/^[0-9a-f]{64}$/.test(sha256) ||
    typeof sourceFile !== "string" ||
    sourceFile === "" ||
    basename(sourceFile) !== sourceFile
  ) {
    return undefined;
  }
  return { episodeId, sha256, sourceFile };
}

async function hashSource(
  path: string,
): Promise<{ readonly sha256Hex: string; readonly episodeId: EpisodeId } | undefined> {
  let bytes: Buffer;
  try {
    bytes = await readFile(path);
  } catch (error: unknown) {
    if (isEnoent(error)) {
      return undefined;
    }
    throw error;
  }
  return {
    sha256Hex: createHash("sha256").update(bytes).digest("hex"),
    episodeId: episodeIdFromAudio(bytes),
  };
}

async function readText(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch (error: unknown) {
    if (isEnoent(error)) {
      return "";
    }
    throw error;
  }
}

async function fileExists(path: string): Promise<boolean> {
  try {
    const info = await stat(path);
    return info.isFile();
  } catch (error: unknown) {
    if (isEnoent(error)) {
      return false;
    }
    throw error;
  }
}

function pathInside(root: string, target: string): boolean {
  const fromRoot = relative(root, target);
  return fromRoot !== "" && !fromRoot.startsWith("..") && !isAbsolute(fromRoot);
}

function rosterList(value: unknown): readonly unknown[] | undefined {
  if (Array.isArray(value)) {
    return value;
  }
  if (!isRecord(value) || "error" in value) {
    return undefined;
  }
  const bots = value["bots"];
  if (Array.isArray(bots)) {
    return bots;
  }
  const agents = value["agents"];
  if (Array.isArray(agents)) {
    return agents;
  }
  return undefined;
}

function rosterItemName(item: unknown): string | undefined {
  if (typeof item === "string" && item !== "") {
    return item;
  }
  if (!isRecord(item)) {
    return undefined;
  }
  const name = stringField(item, "name");
  if (name !== undefined) {
    return name;
  }
  return stringField(item, "id");
}

function skillList(value: unknown): readonly unknown[] | undefined {
  if (Array.isArray(value)) {
    return value;
  }
  if (!isRecord(value)) {
    return undefined;
  }
  const skills = value["skills"];
  return Array.isArray(skills) ? skills : undefined;
}

function labelList(value: unknown): readonly unknown[] | undefined {
  if (Array.isArray(value)) {
    return value;
  }
  if (isRecord(value) && Array.isArray(value["groups"])) {
    return value["groups"];
  }
  return undefined;
}

function skillItemText(item: unknown): string | undefined {
  if (typeof item === "string" && item !== "") {
    return item;
  }
  if (!isRecord(item)) {
    return undefined;
  }
  return stringField(item, "path") ?? stringField(item, "dir") ?? stringField(item, "name");
}

function entryCountField(value: Readonly<Record<string, unknown>>): number | undefined {
  const count = value["entryCount"];
  if (typeof count === "number" && Number.isFinite(count)) {
    return count;
  }
  const entries = value["entries"];
  return Array.isArray(entries) ? entries.length : undefined;
}

function stringField(value: Readonly<Record<string, unknown>>, key: string): string | undefined {
  const field = value[key];
  return typeof field === "string" && field !== "" ? field : undefined;
}

function parseJson(text: string): unknown {
  try {
    const value: unknown = JSON.parse(text);
    return value;
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isEnoent(error: unknown): boolean {
  return isRecord(error) && error["code"] === "ENOENT";
}

function delay(ms: number): Promise<void> {
  return new Promise((resolvePromise) => {
    setTimeout(resolvePromise, ms);
  });
}

function asWorkspacePath(value: string): WorkspacePath {
  return value as WorkspacePath;
}

function asGbotExecutable(value: string): GbotExecutable {
  return value as GbotExecutable;
}

function asSkillDir(value: string): SkillDir {
  return value as SkillDir;
}

function asFixtureWav(value: string): FixtureWav {
  return value as FixtureWav;
}

function asBotName(value: string): BotName {
  return value as BotName;
}

function asHarnessBotName(value: BotName): HarnessBotName {
  return value as HarnessBotName;
}

function asThreadCursor(value: string): ThreadCursor {
  return value as ThreadCursor;
}

function asTaskPrompt(value: string): TaskPrompt {
  return value as TaskPrompt;
}

function brandEpisodeId(value: string): EpisodeId {
  if (!/^ep_[0-9a-f]{16}$/.test(value)) {
    throw new Error("episode id is not ep_ plus 16 lowercase hex digits");
  }
  return value as EpisodeId;
}

if (launchedAsCli()) {
  runFromArgv(process.argv.slice(2))
    .then((code: number) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : "harness failed";
      process.stderr.write(`${message}\n`);
      process.exitCode = 1;
    });
}
