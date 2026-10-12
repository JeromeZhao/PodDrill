/**
 * The local Mac Whistle worker: one python3 process that imports cactus-needle once.
 * Its ready frame is { "kind": "ready", "version": string }, checked against package.json.
 * Result: <needle.transcribe output>, parsed as `WhistleResult`.
 */

import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { asRecord } from "./disk.ts";
import { parseWhistle, type WhistleResult } from "./episode.ts";
import type { SpawnWorker } from "./fleet.ts";
import { PYTHON_FRAMES, spawnFramedWorker, type WorkerFrame } from "./worker.ts";

export interface WhistleQuery extends WorkerFrame {
  readonly language: string;
}

/** Start one warm cactus-needle process. */
export const spawnNeedleWorker: SpawnWorker<WhistleResult, WhistleQuery> = (events) => {
  const pin = pinnedNeedleVersion();
  // A rejection is read by `checkReady`. Until then it must not count as unhandled.
  pin.catch(() => {});
  return spawnFramedWorker<WhistleResult, WhistleQuery>(
    {
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
    },
    events,
  );
};

export async function pinnedNeedleVersion(): Promise<string> {
  const packagePath = join(dirname(fileURLToPath(import.meta.url)), "..", "package.json");
  const packageJson = asRecord(JSON.parse(await readFile(packagePath, "utf8")));
  const version = packageJson === undefined ? undefined : packageJson["cactusNeedle"];
  if (typeof version !== "string" || version.length === 0) {
    throw new Error("package.json does not pin cactus-needle");
  }
  return version;
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
