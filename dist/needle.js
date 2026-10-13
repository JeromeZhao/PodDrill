/**
 * The local Mac Whistle worker: one python3 process that imports cactus-needle once.
 * Its ready frame is { "kind": "ready", "version": string }, checked against package.json.
 * Result: <needle.transcribe output>, parsed as `WhistleResult`.
 */
import { parseWhistle } from "./episode.js";
import { readPackageIdentity } from "./package-identity.js";
import { PYTHON_FRAMES, spawnFramedWorker } from "./worker.js";
/** Start one warm cactus-needle process. */
export const spawnNeedleWorker = (events) => {
    const pin = pinnedNeedleVersion();
    // A rejection is read by `checkReady`. Until then it must not count as unhandled.
    pin.catch(() => { });
    return spawnFramedWorker({
        label: "cactus-needle",
        args: ["-c", WORKER_SCRIPT],
        async checkReady(ready) {
            const version = ready["version"];
            if (typeof version !== "string") {
                return "cactus-needle worker sent a malformed reply";
            }
            const expected = await pin;
            return version === expected ? undefined : `cactus-needle ${version} is not ${expected}`;
        },
        parseResult: parseWhistle,
    }, events);
};
export async function pinnedNeedleVersion() {
    const identity = await readPackageIdentity(import.meta.url);
    return identity.cactusNeedle;
}
const WORKER_SCRIPT = [
    PYTHON_FRAMES,
    "import needle",
    "send({\"kind\": \"ready\", \"version\": needle.__version__})",
    "def transcribe(message):",
    "    language = message.get(\"language\", \"en\")",
    "    if not isinstance(language, str) or language == \"\":",
    "        language = \"en\"",
    "    return needle.transcribe(message[\"wavPath\"], language=language, word_timestamps=True)",
    "serve(transcribe)",
].join("\n");
