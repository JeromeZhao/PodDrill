/**
 * The local Whistle worker: one Python process that imports cactus-needle once.
 * Its ready frame is { "kind": "ready", "version": string }, checked against package.json.
 * Result: <needle.transcribe output>, parsed as `WhistleResult`.
 */
import { parseWhistle } from "./episode.js";
import { readPackageIdentity } from "./package-identity.js";
import { INSTALL_PYTHON_FIX } from "./python-env.js";
import { PYTHON_FRAMES, spawnFramedWorker } from "./worker.js";
/** Start one warm cactus-needle process. */
export const spawnNeedleWorker = (events) => {
    const pin = pinnedNeedleVersion();
    // A rejection is read by `checkReady`. Until then it must not count as unhandled.
    pin.catch(() => { });
    return spawnFramedWorker({
        label: "cactus-needle",
        args: ["-c", WORKER_SCRIPT],
        explainExit(tail) {
            if (tail.includes("No module named 'needle'") || tail.includes("No module named \"needle\"")) {
                return `cactus-needle is not installed. Run ${INSTALL_PYTHON_FIX}.`;
            }
            return tail;
        },
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
