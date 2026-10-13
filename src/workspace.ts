/**
 * Workspace layout and setup config.
 * The only module that builds a path under the workspace. Writers and readers both call `episodeLayout`.
 */

import { randomBytes } from "node:crypto";
import { mkdir, realpath, rename, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";

import { asRecord, errorCode, pathExists, readJsonFile } from "./disk.ts";
import { isModelId, modelIds, type ModelFleet, type ModelId, type ModelWeights } from "./models.ts";
import { homeFromEnv } from "./python-env.ts";
import { isProviderId, providerIds, refuseUnwiredTransport, providerTransport, type ProviderId } from "./provider.ts";

/** Absolute, symlink-resolved workspace directory. Built only by `resolveWorkspace` and `setupWorkspace`. */
export type WorkspaceRoot = string & { readonly __brand: "WorkspaceRoot" };

/**
 * "ep_" plus the first 16 lowercase hex digits of sha256 over the audio bytes.
 * Built only by `episodeIdFromDigest` and `parseEpisodeId`.
 */
export type EpisodeId = string & { readonly __brand: "EpisodeId" };

/** Every artifact an episode lists, in the order it lists them. */
export const artifactKinds = ["transcript", "embedding"] as const;

export type ArtifactKind = (typeof artifactKinds)[number];

/** `poddrill.json`. Written by setup only. Read once by the owner at boot. */
export interface WorkspaceConfig {
  readonly provider: ProviderId;
  /** Maximum episodes whose transcript is queued or running. Integer, at least 1. */
  readonly queueLength: number;
  /**
   * Default fleet size for every model. Integer, at least 1.
   * A file with `whistleLimit` and no `fleetLimit` reads `whistleLimit`. Neither field reads as 1.
   */
  readonly fleetLimit: number;
  /** Per-model sizes. A missing id uses `fleetLimit`. Empty when the file omits the object. */
  readonly modelFleet: ModelFleet;
  /** Absolute weight paths. Empty when the file omits the object. The path does not have to exist. */
  readonly modelWeights: ModelWeights;
  /** Absolute interpreter path recorded by setup. Absent on older files. */
  readonly python?: string;
  /**
   * Most embedding processes the running embedding may use, and most stretches it keeps in flight.
   * Integer, at least 1. A file written without the field reads as 1.
   */
  readonly embeddingLimit: number;
}

export interface WorkspaceDirs {
  readonly root: WorkspaceRoot;
  readonly config: string;
  readonly audioDir: string;
  readonly episodesDir: string;
}

/** One artifact's directory. The stage writes `output` and `workDir`. The store writes `failed`. */
export interface ArtifactLayout {
  readonly dir: string;
  readonly output: string;
  readonly failed: string;
  readonly workDir: string;
}

export interface EpisodeLayout {
  readonly dir: string;
  readonly manifest: string;
  /** Speaker groups built from the embedding. Absent until the first cues read. */
  readonly groups: string;
  /** Names and marks for those groups. Absent until a label write. */
  readonly labels: string;
  readonly summaries: string;
  /** One JSON line per finished owner call. Absent until the first logged call. */
  readonly audit: string;
  readonly artifacts: Readonly<Record<ArtifactKind, ArtifactLayout>>;
  /** `source<extension>`, for example `source.mp3`. */
  source(extension: string): string;
  summaryFile(summaryId: string): string;
}

/** The two files one slice leaves on disk. */
export interface SliceFiles {
  readonly wavPath: string;
  readonly whistlePath: string;
}

export interface SetupReport {
  readonly dirs: WorkspaceDirs;
  readonly config: WorkspaceConfig;
}

/** The owner reads `poddrill.json` only at boot, so a live owner would keep running the old config. */
export type SetupResult =
  | { readonly kind: "ready"; readonly report: SetupReport }
  | {
      readonly kind: "rejected";
      readonly reason: "owner-running";
      readonly current: WorkspaceConfig;
      readonly message: string;
    };

const CONFIG_FILE = "poddrill.json";
const AUDIO_DIR = "audio";
const EPISODES_DIR = "episodes";

const ARTIFACT_OUTPUTS: Readonly<Record<ArtifactKind, string>> = {
  transcript: "transcript.vtt",
  embedding: "embedding.json",
};

/** `PODDRILL_WORKSPACE`, else `~/poddrill`. Setup and every other command use this path. */
export function defaultWorkspacePath(env: Readonly<Record<string, string | undefined>>): string {
  const configured = env["PODDRILL_WORKSPACE"];
  if (configured !== undefined && configured !== "") {
    return resolve(configured);
  }
  return resolve(join(homeFromEnv(env), "poddrill"));
}

/** `PODDRILL_WORKSPACE`, else `~/poddrill`, resolved with realpath. */
export async function resolveWorkspace(
  env: Readonly<Record<string, string | undefined>>,
): Promise<WorkspaceRoot> {
  const candidate = defaultWorkspacePath(env);
  let root: WorkspaceRoot;
  try {
    root = asWorkspaceRoot(await realpath(candidate));
  } catch (error) {
    if (errorCode(error) === "ENOENT") {
      throw new Error(`no poddrill workspace at ${candidate}. Run poddrill setup first.`);
    }
    throw error;
  }
  if (!(await pathExists(workspaceDirs(root).config))) {
    throw new Error(`no ${CONFIG_FILE} in ${root}. Run poddrill setup first.`);
  }
  return root;
}

export async function readConfig(root: WorkspaceRoot): Promise<WorkspaceConfig> {
  const path = workspaceDirs(root).config;
  const config = parseConfig(await readJsonFile(path));
  if (config === undefined) {
    throw new Error(
      [
        `${path} must name a provider (${providerIds.join(", ")}), a positive integer queueLength,`,
        "and, if present, a positive integer fleetLimit and embeddingLimit",
      ].join(" "),
    );
  }
  return config;
}

/**
 * Create `audio/` and `episodes/`, and write `poddrill.json` atomically when it changes.
 * `ownerAlive` comes from the caller's socket probe.
 */
export async function setupWorkspace(input: {
  readonly root: string;
  readonly provider: string;
  readonly queueLength: number;
  /** Omitted keeps the on-disk size. An old file's `whistleLimit` is that size. */
  readonly fleetLimit?: number;
  /** Omitted keeps the on-disk map. Present replaces it. */
  readonly modelFleet?: ModelFleet;
  /** Omitted keeps the on-disk map. Present replaces it. */
  readonly modelWeights?: ModelWeights;
  /** Omitted keeps the on-disk value, or 1 when the file has none or does not parse. */
  readonly embeddingLimit?: number;
  /** Omitted keeps the on-disk path. Present replaces it. Absolute. */
  readonly python?: string;
  readonly ownerAlive: boolean;
}): Promise<SetupResult> {
  if (!isProviderId(input.provider)) {
    throw new Error(`unknown provider ${input.provider}. Use one of ${providerIds.join(", ")}.`);
  }
  refuseUnwiredTransport(input.provider, providerTransport(input.provider));
  if (!isCount(input.queueLength)) {
    throw new Error(`queue length must be a positive integer, got ${input.queueLength}`);
  }
  if (input.fleetLimit !== undefined && !isCount(input.fleetLimit)) {
    throw new Error(`fleet limit must be a positive integer, got ${input.fleetLimit}`);
  }
  if (input.embeddingLimit !== undefined && !isCount(input.embeddingLimit)) {
    throw new Error(`embedding limit must be a positive integer, got ${input.embeddingLimit}`);
  }
  if (input.python !== undefined && !isAbsolute(input.python)) {
    throw new Error(`python must be an absolute path, got ${input.python}`);
  }
  const requested = resolve(input.root);
  const current = parseConfig(await readJsonFile(join(requested, CONFIG_FILE)));
  const modelFleet = input.modelFleet ?? current?.modelFleet ?? {};
  const modelWeights = input.modelWeights ?? current?.modelWeights ?? {};
  assertModelFleet(modelFleet);
  assertModelWeights(modelWeights);
  const python = pythonPath(input.python, current?.python);
  const config: WorkspaceConfig = {
    provider: input.provider,
    queueLength: input.queueLength,
    fleetLimit: input.fleetLimit ?? current?.fleetLimit ?? 1,
    modelFleet,
    modelWeights,
    embeddingLimit: input.embeddingLimit ?? current?.embeddingLimit ?? 1,
    ...(python === undefined ? {} : { python }),
  };
  const unchanged = current !== undefined && sameConfig(current, config);

  if (input.ownerAlive && current !== undefined && !unchanged) {
    return {
      kind: "rejected",
      reason: "owner-running",
      current,
      message: [
        `poddrill serve is running with provider ${current.provider},`,
        `queue length ${current.queueLength}, fleet limit ${current.fleetLimit},`,
        `and embedding limit ${current.embeddingLimit}.`,
        "Stop it with poddrill stop before changing the setup.",
      ].join(" "),
    };
  }

  await mkdir(join(requested, AUDIO_DIR), { recursive: true });
  await mkdir(join(requested, EPISODES_DIR), { recursive: true });
  const dirs = workspaceDirs(asWorkspaceRoot(await realpath(requested)));
  if (!unchanged) {
    const temp = `${dirs.config}.${randomBytes(4).toString("hex")}.tmp`;
    await writeFile(temp, writtenConfig(config));
    await rename(temp, dirs.config);
  }
  return {
    kind: "ready",
    report: {
      dirs,
      config,
    },
  };
}

export function workspaceDirs(root: WorkspaceRoot): WorkspaceDirs {
  return {
    root,
    config: join(root, CONFIG_FILE),
    audioDir: join(root, AUDIO_DIR),
    episodesDir: join(root, EPISODES_DIR),
  };
}

export function episodeLayout(root: WorkspaceRoot, id: EpisodeId): EpisodeLayout {
  const dir = join(root, EPISODES_DIR, id);
  const artifact = (kind: ArtifactKind): ArtifactLayout => {
    const artifactDir = join(dir, kind);
    return {
      dir: artifactDir,
      output: join(artifactDir, ARTIFACT_OUTPUTS[kind]),
      failed: join(artifactDir, "failed.json"),
      workDir: join(artifactDir, "work"),
    };
  };
  return {
    dir,
    manifest: join(dir, "episode.json"),
    groups: join(dir, "groups.json"),
    labels: join(dir, "labels.json"),
    summaries: join(dir, "summaries"),
    audit: join(dir, "audit.jsonl"),
    artifacts: { transcript: artifact("transcript"), embedding: artifact("embedding") },
    source: (extension) => join(dir, `source${extension}`),
    summaryFile: (summaryId) => join(dir, "summaries", `${summaryId}.yaml`),
  };
}

/** `transcript/work/0007.wav` and `transcript/work/0007.whistle.json` for index 7. */
export function sliceFiles(layout: EpisodeLayout, index: number): SliceFiles {
  const name = workName(index);
  const workDir = layout.artifacts.transcript.workDir;
  return {
    wavPath: join(workDir, `${name}.wav`),
    whistlePath: join(workDir, `${name}.whistle.json`),
  };
}

/** `embedding/work/0007.wav` for stretch 7. */
export function stretchWav(layout: EpisodeLayout, index: number): string {
  return join(layout.artifacts.embedding.workDir, `${workName(index)}.wav`);
}

export function episodeIdFromDigest(sha256Hex: string): EpisodeId {
  if (!/^[0-9a-f]{64}$/.test(sha256Hex)) {
    throw new Error("an episode id needs a sha256 digest of 64 lowercase hex digits");
  }
  return asEpisodeId(`ep_${sha256Hex.slice(0, 16)}`);
}

/** Anything but `^ep_[0-9a-f]{16}$` is `undefined`, which the episode read reports as `unknown`. */
export function parseEpisodeId(value: string): EpisodeId | undefined {
  return /^ep_[0-9a-f]{16}$/.test(value) ? asEpisodeId(value) : undefined;
}

function workName(index: number): string {
  return String(index).padStart(4, "0");
}

function parseConfig(value: unknown): WorkspaceConfig | undefined {
  const record = asRecord(value);
  if (record === undefined) {
    return undefined;
  }
  const provider = record["provider"];
  const queueLength = record["queueLength"];
  if (typeof provider !== "string" || !isProviderId(provider)) {
    return undefined;
  }
  if (!isCount(queueLength)) {
    return undefined;
  }
  const fleetLimit = readFleetLimit(record);
  const embeddingLimit = optionalCount(record["embeddingLimit"]);
  const python = readPython(record);
  if (fleetLimit === undefined || embeddingLimit === undefined) {
    return undefined;
  }
  return {
    provider,
    queueLength,
    fleetLimit,
    modelFleet: readModelFleet(record["modelFleet"]),
    modelWeights: readModelWeights(record["modelWeights"]),
    embeddingLimit,
    ...(python === undefined ? {} : { python }),
  };
}

function readPython(record: Record<string, unknown>): string | undefined {
  if (!Object.prototype.hasOwnProperty.call(record, "python")) {
    return undefined;
  }
  const python = record["python"];
  if (typeof python !== "string" || !isAbsolute(python)) {
    throw new Error(`python must be an absolute path, got ${String(python)}`);
  }
  return python;
}

/**
 * `fleetLimit` wins. An old file that only has `whistleLimit` uses that number.
 * Neither field reads as 1. A present field that is not a positive integer does not parse.
 */
function readFleetLimit(record: Record<string, unknown>): number | undefined {
  if ("fleetLimit" in record) {
    return optionalCount(record["fleetLimit"]);
  }
  if ("whistleLimit" in record) {
    return optionalCount(record["whistleLimit"]);
  }
  return 1;
}

function readModelFleet(value: unknown): ModelFleet {
  if (value === undefined) {
    return {};
  }
  const record = asRecord(value);
  if (record === undefined) {
    throw new Error("modelFleet must be an object");
  }
  const fleet: Partial<Record<ModelId, number>> = {};
  for (const [key, count] of Object.entries(record)) {
    if (!isModelId(key)) {
      throw new Error(`unknown model ${key}`);
    }
    if (!isCount(count)) {
      throw new Error(`fleet size for ${key} must be a positive integer, got ${String(count)}`);
    }
    fleet[key] = count;
  }
  return fleet;
}

function readModelWeights(value: unknown): ModelWeights {
  if (value === undefined) {
    return {};
  }
  const record = asRecord(value);
  if (record === undefined) {
    throw new Error("modelWeights must be an object");
  }
  const weights: Partial<Record<ModelId, string>> = {};
  for (const [key, path] of Object.entries(record)) {
    if (!isModelId(key)) {
      throw new Error(`unknown model ${key}`);
    }
    if (typeof path !== "string" || !isAbsolute(path)) {
      throw new Error(`model weights path for ${key} must be absolute, got ${String(path)}`);
    }
    weights[key] = path;
  }
  return weights;
}

function assertModelFleet(fleet: ModelFleet): void {
  for (const id of modelIds) {
    const count = fleet[id];
    if (count !== undefined && !isCount(count)) {
      throw new Error(`fleet size for ${id} must be a positive integer, got ${String(count)}`);
    }
  }
}

function assertModelWeights(weights: ModelWeights): void {
  for (const id of modelIds) {
    const path = weights[id];
    if (path !== undefined && !isAbsolute(path)) {
      throw new Error(`model weights path for ${id} must be absolute, got ${path}`);
    }
  }
}

function writtenConfig(config: WorkspaceConfig): string {
  const body: Record<string, unknown> = {
    provider: config.provider,
    queueLength: config.queueLength,
    fleetLimit: config.fleetLimit,
  };
  if (modelIds.some((id) => config.modelFleet[id] !== undefined)) {
    body["modelFleet"] = config.modelFleet;
  }
  if (modelIds.some((id) => config.modelWeights[id] !== undefined)) {
    body["modelWeights"] = config.modelWeights;
  }
  body["embeddingLimit"] = config.embeddingLimit;
  if (config.python !== undefined) {
    body["python"] = config.python;
  }
  return `${JSON.stringify(body, null, 2)}\n`;
}

function pythonPath(requested: string | undefined, current: string | undefined): string | undefined {
  return requested ?? current;
}

/** Absent reads as 1. Present and not a positive integer is `undefined`. */
function optionalCount(value: unknown): number | undefined {
  if (value === undefined) {
    return 1;
  }
  return isCount(value) ? value : undefined;
}

function sameConfig(a: WorkspaceConfig, b: WorkspaceConfig): boolean {
  return (
    a.provider === b.provider &&
    a.queueLength === b.queueLength &&
    a.fleetLimit === b.fleetLimit &&
    a.embeddingLimit === b.embeddingLimit &&
    a.python === b.python &&
    sameById(a.modelFleet, b.modelFleet) &&
    sameById(a.modelWeights, b.modelWeights)
  );
}

function sameById(
  left: Readonly<Partial<Record<ModelId, number | string>>>,
  right: Readonly<Partial<Record<ModelId, number | string>>>,
): boolean {
  return modelIds.every((id) => left[id] === right[id]);
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1;
}

function asWorkspaceRoot(path: string): WorkspaceRoot {
  return path as WorkspaceRoot;
}

function asEpisodeId(value: string): EpisodeId {
  return value as EpisodeId;
}
