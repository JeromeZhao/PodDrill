/**
 * Public transcribe entry.
 * Planning and WebVTT live in episode.ts. Hosts live in provider.ts.
 */
import { planSlices, projectSlices, } from "./episode.js";
import { isProviderId, openWhistleCall } from "./provider.js";
/** The installing agent calls this once. Later transcribe calls read the same id. */
export function selectProvider(providerId) {
    if (!isProviderId(providerId)) {
        throw new Error(`unknown provider ${providerId}`);
    }
    return { providerId };
}
/**
 * Run Whistle on slices that were already cut, then project WebVTT.
 * The host is the profile from setup, not an argument that changes the cutter.
 */
export async function transcribePrepared(input) {
    const language = input.language ?? "en";
    const host = openWhistleCall(input.profile.providerId, {
        fleetLimit: input.fleetLimit,
        modelFleet: input.modelFleet ?? {},
        modelWeights: input.modelWeights ?? {},
    });
    try {
        const records = [];
        for (const slice of input.slices) {
            const job = {
                sliceIndex: slice.index,
                startMs: slice.startMs,
                wavPath: slice.wavPath,
                language,
            };
            const whistle = await host.transcribeSlice(job);
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
    }
    finally {
        await host.close();
    }
}
export { planSlices, projectSlices };
