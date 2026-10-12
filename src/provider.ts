/**
 * Hosts that run a transcript model. The episode module never imports this file.
 * A new host is a new id in `providerIds` and a `WhistleHost` factory.
 */

import type { WhistleResult } from "./episode.ts";
import { openFleet, type SpawnWorker, type WorkerPool } from "./fleet.ts";
import { fleetSize, modelForLanguage, type LanguageModel, type ModelFleet, type ModelId, type ModelWeights } from "./models.ts";
import { moonshineFailureMessage, spawnMoonshineWorker } from "./moonshine.ts";
import { spawnNeedleWorker, type WhistleQuery } from "./needle.ts";

/** One slice the pipeline already cut. The path is the exact audio the model must hear. */
export interface SliceJob {
  readonly sliceIndex: number;
  readonly startMs: number;
  readonly wavPath: string;
  readonly language: string;
}

/**
 * What the job queue sees of a host. Callers may overlap calls.
 * The host bounds its own processes, so overlap past its limit waits rather than spawns.
 */
export interface WhistleCall {
  transcribeSlice(job: SliceJob): Promise<WhistleResult>;
}

/**
 * A `WhistleCall` plus its lifetime. Only the creator holds this type, so only the creator closes it.
 * `JobQueue` takes `WhistleCall` and cannot end the host it uses.
 */
export interface WhistleHost extends WhistleCall {
  /**
   * End every worker by closing its pipes, and reject calls that are still waiting.
   * Idempotent. Does not wait for a busy worker to finish its slice.
   */
  close(): Promise<void>;
  /** Drop idle workers and leave the host open. False means a pool still has work. */
  release(): boolean;
}

/** Sizes and weight paths the owner already parsed. A missing fleet key uses `fleetLimit`. */
export interface HostFleet {
  readonly fleetLimit: number;
  readonly modelFleet: ModelFleet;
  readonly modelWeights: ModelWeights;
}

export const providerIds = ["localhost", "grok-bot", "cursor-cloud"] as const;

export type ProviderId = (typeof providerIds)[number];

export function isProviderId(value: string): value is ProviderId {
  return (providerIds as readonly string[]).includes(value);
}

/**
 * `undefined` when this model can run.
 * A missing Moonshine weight path fails here and does not download. A present path runs the worker.
 */
export function transcriptRefusal(model: LanguageModel, weights: ModelWeights): string | undefined {
  switch (model.engine) {
    case "whistle":
      return undefined;
    case "moonshine":
      return weights[model.id] === undefined ? `${model.id} has no weights path` : undefined;
    default: {
      const leftover: never = model;
      throw new Error(`unexpected model ${JSON.stringify(leftover)}`);
    }
  }
}

/**
 * Mac runs one warm pool per model id. Nothing spawns until that id's first slice.
 * Grok Bot's computer and Cursor's cloud computer are not wired yet.
 */
const factories: Record<
  ProviderId,
  (
    config: HostFleet,
    whistleSpawn: SpawnWorker<WhistleResult, WhistleQuery>,
    moonshineSpawn: typeof spawnMoonshineWorker,
  ) => WhistleHost
> = {
  localhost: (config, whistleSpawn, moonshineSpawn) => openMacHost(config, whistleSpawn, moonshineSpawn),
  "grok-bot": () => unwiredHost("grok-bot"),
  "cursor-cloud": () => unwiredHost("cursor-cloud"),
};

/** Open the host selected at setup. Spawns nothing until the first slice of a model. */
export function openWhistleCall(
  providerId: ProviderId,
  config: HostFleet,
  whistleSpawn: SpawnWorker<WhistleResult, WhistleQuery> = spawnNeedleWorker,
  moonshineSpawn: typeof spawnMoonshineWorker = spawnMoonshineWorker,
): WhistleHost {
  if (!Number.isInteger(config.fleetLimit) || config.fleetLimit < 1) {
    throw new Error(`fleet limit must be a positive integer, got ${config.fleetLimit}`);
  }
  return factories[providerId](config, whistleSpawn, moonshineSpawn);
}

function openMacHost(
  config: HostFleet,
  whistleSpawn: SpawnWorker<WhistleResult, WhistleQuery>,
  moonshineSpawn: typeof spawnMoonshineWorker,
): WhistleHost {
  const pools = new Map<ModelId, WorkerPool<WhistleResult, WhistleQuery>>();
  const poolFor = (model: LanguageModel): WorkerPool<WhistleResult, WhistleQuery> => {
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
    transcribeSlice(job: SliceJob): Promise<WhistleResult> {
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
    async close(): Promise<void> {
      await Promise.all([...pools.values()].map((pool) => pool.close()));
    },
    release(): boolean {
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

function spawnFor(
  model: LanguageModel,
  weights: ModelWeights,
  whistleSpawn: SpawnWorker<WhistleResult, WhistleQuery>,
  moonshineSpawn: typeof spawnMoonshineWorker,
): SpawnWorker<WhistleResult, WhistleQuery> {
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
          request: (query) =>
            link.request({ wavPath: query.wavPath }).catch((error: unknown) => {
              const message = error instanceof Error ? error.message : String(error);
              return Promise.reject(new Error(moonshineFailureMessage(message)));
            }),
          close: () => link.close(),
        };
      };
    }
    default: {
      const leftover: never = model;
      throw new Error(`unexpected model ${JSON.stringify(leftover)}`);
    }
  }
}

function unwiredHost(providerId: ProviderId): WhistleHost {
  return {
    async transcribeSlice(): Promise<WhistleResult> {
      throw new Error(`${providerId} provider transport is not wired`);
    },
    async close(): Promise<void> {},
    release(): boolean {
      return true;
    },
  };
}
