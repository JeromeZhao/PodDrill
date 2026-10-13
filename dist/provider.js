/**
 * Hosts that run a transcript model. The episode module never imports this file.
 * A new host is a new id in `providerIds` and a `providerTransport` case.
 * An `"unwired"` transport is refused by setup and by `openWhistleCall`.
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
/** `localhost`, `grok-bot`, and `cursor-cloud` all run the local Python host. */
export function providerTransport(id) {
    switch (id) {
        case "localhost":
        case "grok-bot":
        case "cursor-cloud":
            return "local";
        default: {
            const leftover = id;
            throw new Error(`unexpected provider ${JSON.stringify(leftover)}`);
        }
    }
}
export function unwiredProviderMessage(id) {
    return `${id} provider transport is not wired. poddrill setup refuses a provider that cannot transcribe.`;
}
/** Setup and `openWhistleCall` both call this before a worker can start. */
export function refuseUnwiredTransport(id, transport) {
    if (transport === "unwired") {
        throw new Error(unwiredProviderMessage(id));
    }
}
/** Open the host selected at setup. Spawns nothing until the first slice of a model. */
export function openWhistleCall(providerId, config, whistleSpawn = spawnNeedleWorker, moonshineSpawn = spawnMoonshineWorker) {
    refuseUnwiredTransport(providerId, providerTransport(providerId));
    if (!Number.isInteger(config.fleetLimit) || config.fleetLimit < 1) {
        throw new Error(`fleet limit must be a positive integer, got ${config.fleetLimit}`);
    }
    return openLocalHost(config, whistleSpawn, moonshineSpawn);
}
function openLocalHost(config, whistleSpawn, moonshineSpawn) {
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
