/**
 * Workspace layout and setup config.
 * The only module that builds a path under the workspace. Writers and readers both call `episodeLayout`.
 */
import { randomBytes } from "node:crypto";
import { mkdir, realpath, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { asRecord, errorCode, pathExists, readJsonFile } from "./disk.js";
import { isModelId, modelIds } from "./models.js";
import { isProviderId, providerIds } from "./provider.js";
/** Every artifact an episode lists, in the order it lists them. */
export const artifactKinds = ["transcript", "embedding"];
const CONFIG_FILE = "poddrill.json";
const AUDIO_DIR = "audio";
const EPISODES_DIR = "episodes";
const ARTIFACT_OUTPUTS = {
    transcript: "transcript.vtt",
    embedding: "embedding.json",
};
/** `PODDRILL_WORKSPACE`, else `~/poddrill`, resolved with realpath. */
export async function resolveWorkspace(env) {
    const configured = env["PODDRILL_WORKSPACE"];
    const candidate = resolve(configured === undefined || configured === "" ? join(homedir(), "poddrill") : configured);
    let root;
    try {
        root = asWorkspaceRoot(await realpath(candidate));
    }
    catch (error) {
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
export async function readConfig(root) {
    const path = workspaceDirs(root).config;
    const config = parseConfig(await readJsonFile(path));
    if (config === undefined) {
        throw new Error([
            `${path} must name a provider (${providerIds.join(", ")}), a positive integer queueLength,`,
            "and, if present, a positive integer fleetLimit and embeddingLimit",
        ].join(" "));
    }
    return config;
}
/**
 * Create `audio/` and `episodes/`, and write `poddrill.json` atomically when it changes.
 * `ownerAlive` comes from the caller's socket probe.
 */
export async function setupWorkspace(input) {
    if (!isProviderId(input.provider)) {
        throw new Error(`unknown provider ${input.provider}. Use one of ${providerIds.join(", ")}.`);
    }
    if (!isCount(input.queueLength)) {
        throw new Error(`queue length must be a positive integer, got ${input.queueLength}`);
    }
    if (input.fleetLimit !== undefined && !isCount(input.fleetLimit)) {
        throw new Error(`fleet limit must be a positive integer, got ${input.fleetLimit}`);
    }
    if (input.embeddingLimit !== undefined && !isCount(input.embeddingLimit)) {
        throw new Error(`embedding limit must be a positive integer, got ${input.embeddingLimit}`);
    }
    const requested = resolve(input.root);
    const current = parseConfig(await readJsonFile(join(requested, CONFIG_FILE)));
    const modelFleet = input.modelFleet ?? current?.modelFleet ?? {};
    const modelWeights = input.modelWeights ?? current?.modelWeights ?? {};
    assertModelFleet(modelFleet);
    assertModelWeights(modelWeights);
    const config = {
        provider: input.provider,
        queueLength: input.queueLength,
        fleetLimit: input.fleetLimit ?? current?.fleetLimit ?? 1,
        modelFleet,
        modelWeights,
        embeddingLimit: input.embeddingLimit ?? current?.embeddingLimit ?? 1,
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
                "Stop it before changing the setup.",
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
export function workspaceDirs(root) {
    return {
        root,
        config: join(root, CONFIG_FILE),
        audioDir: join(root, AUDIO_DIR),
        episodesDir: join(root, EPISODES_DIR),
    };
}
export function episodeLayout(root, id) {
    const dir = join(root, EPISODES_DIR, id);
    const artifact = (kind) => {
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
export function sliceFiles(layout, index) {
    const name = workName(index);
    const workDir = layout.artifacts.transcript.workDir;
    return {
        wavPath: join(workDir, `${name}.wav`),
        whistlePath: join(workDir, `${name}.whistle.json`),
    };
}
/** `embedding/work/0007.wav` for stretch 7. */
export function stretchWav(layout, index) {
    return join(layout.artifacts.embedding.workDir, `${workName(index)}.wav`);
}
export function episodeIdFromDigest(sha256Hex) {
    if (!/^[0-9a-f]{64}$/.test(sha256Hex)) {
        throw new Error("an episode id needs a sha256 digest of 64 lowercase hex digits");
    }
    return asEpisodeId(`ep_${sha256Hex.slice(0, 16)}`);
}
/** Anything but `^ep_[0-9a-f]{16}$` is `undefined`, which the episode read reports as `unknown`. */
export function parseEpisodeId(value) {
    return /^ep_[0-9a-f]{16}$/.test(value) ? asEpisodeId(value) : undefined;
}
function workName(index) {
    return String(index).padStart(4, "0");
}
function parseConfig(value) {
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
    };
}
/**
 * `fleetLimit` wins. An old file that only has `whistleLimit` uses that number.
 * Neither field reads as 1. A present field that is not a positive integer does not parse.
 */
function readFleetLimit(record) {
    if ("fleetLimit" in record) {
        return optionalCount(record["fleetLimit"]);
    }
    if ("whistleLimit" in record) {
        return optionalCount(record["whistleLimit"]);
    }
    return 1;
}
function readModelFleet(value) {
    if (value === undefined) {
        return {};
    }
    const record = asRecord(value);
    if (record === undefined) {
        throw new Error("modelFleet must be an object");
    }
    const fleet = {};
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
function readModelWeights(value) {
    if (value === undefined) {
        return {};
    }
    const record = asRecord(value);
    if (record === undefined) {
        throw new Error("modelWeights must be an object");
    }
    const weights = {};
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
function assertModelFleet(fleet) {
    for (const id of modelIds) {
        const count = fleet[id];
        if (count !== undefined && !isCount(count)) {
            throw new Error(`fleet size for ${id} must be a positive integer, got ${String(count)}`);
        }
    }
}
function assertModelWeights(weights) {
    for (const id of modelIds) {
        const path = weights[id];
        if (path !== undefined && !isAbsolute(path)) {
            throw new Error(`model weights path for ${id} must be absolute, got ${path}`);
        }
    }
}
function writtenConfig(config) {
    const body = {
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
    return `${JSON.stringify(body, null, 2)}\n`;
}
/** Absent reads as 1. Present and not a positive integer is `undefined`. */
function optionalCount(value) {
    if (value === undefined) {
        return 1;
    }
    return isCount(value) ? value : undefined;
}
function sameConfig(a, b) {
    return (a.provider === b.provider &&
        a.queueLength === b.queueLength &&
        a.fleetLimit === b.fleetLimit &&
        a.embeddingLimit === b.embeddingLimit &&
        sameById(a.modelFleet, b.modelFleet) &&
        sameById(a.modelWeights, b.modelWeights));
}
function sameById(left, right) {
    return modelIds.every((id) => left[id] === right[id]);
}
function isCount(value) {
    return typeof value === "number" && Number.isInteger(value) && value >= 1;
}
function asWorkspaceRoot(path) {
    return path;
}
function asEpisodeId(value) {
    return value;
}
