/**
 * Public transcribe entry.
 * Planning and WebVTT live in episode.ts. Hosts live in provider.ts.
 */

import {
  planSlices,
  projectSlices,
  type Projection,
  type SliceRecord,
  type WhistleResult,
} from "./episode.ts";
import type { ModelFleet, ModelWeights } from "./models.ts";
import { isProviderId, openWhistleCall, type ProviderId, type SliceJob } from "./provider.ts";

export interface HostProfile {
  readonly providerId: ProviderId;
}

/** The installing agent calls this once. Later transcribe calls read the same id. */
export function selectProvider(providerId: string): HostProfile {
  if (!isProviderId(providerId)) {
    throw new Error(`unknown provider ${providerId}`);
  }
  return { providerId };
}

export interface PreparedSlice {
  readonly index: number;
  readonly startMs: number;
  readonly endMs: number;
  readonly keepStartMs: number;
  readonly keepEndMs: number;
  readonly wavPath: string;
}

/**
 * Run Whistle on slices that were already cut, then project WebVTT.
 * The host is the profile from setup, not an argument that changes the cutter.
 */
export async function transcribePrepared(input: {
  readonly profile: HostProfile;
  readonly slices: readonly PreparedSlice[];
  readonly language?: string;
  readonly fleetLimit: number;
  readonly modelFleet?: ModelFleet;
  readonly modelWeights?: ModelWeights;
}): Promise<Projection> {
  const language = input.language ?? "en";
  const host = openWhistleCall(input.profile.providerId, {
    fleetLimit: input.fleetLimit,
    modelFleet: input.modelFleet ?? {},
    modelWeights: input.modelWeights ?? {},
  });
  try {
    const records: SliceRecord[] = [];
    for (const slice of input.slices) {
      const job: SliceJob = {
        sliceIndex: slice.index,
        startMs: slice.startMs,
        wavPath: slice.wavPath,
        language,
      };
      const whistle: WhistleResult = await host.transcribeSlice(job);
      records.push({
        plan: {
          index: slice.index,
          startMs: slice.startMs,
          endMs: slice.endMs,
          keepStartMs: slice.keepStartMs,
          keepEndMs: slice.keepEndMs,
        },
        slicePath: slice.wavPath,
        whistle,
      });
    }
    return projectSlices(records);
  } finally {
    await host.close();
  }
}

export { planSlices, projectSlices };
export type { Projection };
