/**
 * Hosts that run a transcript model. The episode module never imports this file.
 * A new host is a new id in `providerIds` and a `WhistleHost` factory.
 */
import { openFleet } from "./fleet.js";
import { fleetSize, modelForLanguage } from "./models.js";
import { moonshineFailureMessage, spawnMoonshineWorker } from "./moonshine.js";
import { spawnNeedleWorker } from "./needle.js";
export const providerIds = ["localhost", "grok-bot", "cursor-cloud"];
export function isProviderId(value) {
    return providerIds.includes(value);
}
/**
 * `undefined` when this model can run.
 * A missing Moonshine weight path fails here and does not download. A present path runs the worker.
 */
export function transcriptRefusal(model, weights) {
    switch (model.engine) {
        case "whistle":
            return undefined;
        case "moonshine":
            return weights[model.id] === undefined ? `${model.id} has no weights path` : undefined;
        default: {
            const leftover = model;
            throw new Error(`unexpected model ${JSON.stringify(leftover)}`);
        }
    }
}
/**
 * Mac runs one warm pool per model id. Nothing spawns until that id's first slice.
 * Grok Bot's computer and Cursor's cloud computer are not wired yet.
 */
const factories = {
    localhost: (config, whistleSpawn, moonshineSpawn) => openMacHost(config, whistleSpawn, moonshineSpawn),
    "grok-bot": () => unwiredHost("grok-bot"),
    "cursor-cloud": () => unwiredHost("cursor-cloud"),
};
/** Open the host selected at setup. Spawns nothing until the first slice of a model. */
export function openWhistleCall(providerId, config, whistleSpawn = spawnNeedleWorker, moonshineSpawn = spawnMoonshineWorker) {
    if (!Number.isInteger(config.fleetLimit) || config.fleetLimit < 1) {
        throw new Error(`fleet limit must be a positive integer, got ${config.fleetLimit}`);
    }
    return factories[providerId](config, whistleSpawn, moonshineSpawn);
}
function openMacHost(config, whistleSpawn, moonshineSpawn) {
    const pools = new Map();
    const poolFor = (model) => {
        const existing = pools.get(model.id);
        if (existing !== undefined) {
            return existing;
        }
        const pool = openFleet({
            limit: fleetSize(model.id, config),
            spawn: spawnFor(model, config.modelWeights, whistleSpawn, moonshineSpawn),
            closedMessage: "whistle host is closed",
        });
        pools.set(model.id, pool);
        return pool;
    };
    return {
        transcribeSlice(job) {
            const model = modelForLanguage(job.language);
            if (model === undefined) {
                return Promise.reject(new Error(`unknown language ${job.language}`));
            }
            const refusal = transcriptRefusal(model, config.modelWeights);
            if (refusal !== undefined) {
                return Promise.reject(new Error(refusal));
            }
            return poolFor(model).run({ wavPath: job.wavPath, language: job.language });
        },
        async close() {
            await Promise.all([...pools.values()].map((pool) => pool.close()));
        },
        release() {
            let clear = true;
            for (const pool of pools.values()) {
                if (!pool.release()) {
                    clear = false;
                }
            }
            return clear;
        },
    };
}
function spawnFor(model, weights, whistleSpawn, moonshineSpawn) {
    switch (model.engine) {
        case "whistle":
            return whistleSpawn;
        case "moonshine": {
            const weightsDir = weights[model.id];
            if (weightsDir === undefined) {
                throw new Error(`${model.id} has no weights path`);
            }
            const spawn = moonshineSpawn(model, weightsDir);
            return (events) => {
                const link = spawn(events);
                return {
                    request: (query) => link.request({ wavPath: query.wavPath }).catch((error) => {
                        const message = error instanceof Error ? error.message : String(error);
                        return Promise.reject(new Error(moonshineFailureMessage(message)));
                    }),
                    close: () => link.close(),
                };
            };
        }
        default: {
            const leftover = model;
            throw new Error(`unexpected model ${JSON.stringify(leftover)}`);
        }
    }
}
function unwiredHost(providerId) {
    return {
        async transcribeSlice() {
            throw new Error(`${providerId} provider transport is not wired`);
        },
        async close() { },
        release() {
            return true;
        },
    };
}
