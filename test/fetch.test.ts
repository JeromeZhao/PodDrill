import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const scriptPath = fileURLToPath(
  new URL("../.agents/skills/poddrill/scripts/fetch-audio.mjs", import.meta.url),
);
const episodeUrl =
  "https://dts.podtrac.com/redirect.mp3/traffic.libsyn.com/secure/allinchamathjason/ALLIN-E292_Ch.mp3?dest-id=1928300";
const episodeByteLength = "134265006";

interface FetchRun {
  readonly code: number;
  readonly stderr: string;
}

function runFetch(url: string, outputPath: string, expectedByteLength: string): Promise<FetchRun> {
  return new Promise((resolveRun, rejectRun) => {
    execFile(
      process.execPath,
      [scriptPath, url, outputPath, expectedByteLength],
      { encoding: "utf8" },
      (error, _stdout, stderr) => {
        if (error === null) {
          resolveRun({ code: 0, stderr });
          return;
        }
        if (typeof error.code === "number") {
          resolveRun({ code: error.code, stderr });
          return;
        }
        rejectRun(error);
      },
    );
  });
}

describe("downloadTo", () => {
  it("rejects an output path inside the repo", async () => {
    const outputPath = join(repoRoot, "e292-out", "ALLIN-E292_Ch.mp3");
    const result = await runFetch(episodeUrl, outputPath, episodeByteLength);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /refusing to write inside the git tree/);
    await assert.rejects(() => stat(join(repoRoot, "e292-out")), { code: "ENOENT" });
  });
});
