import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { copyFile, mkdtemp, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
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

  it("tries the download when the script is outside a git tree", async () => {
    const dir = await mkdtemp(join(tmpdir(), "poddrill-fetch-"));
    const copied = join(dir, "fetch-audio.mjs");
    const outputPath = join(dir, "out.mp3");
    try {
      await copyFile(scriptPath, copied);
      const invoked = await realpath(copied);
      const result = await new Promise<FetchRun>((resolveRun, rejectRun) => {
        execFile(
          process.execPath,
          [invoked, "http://127.0.0.1:9/audio.mp3", outputPath],
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
      assert.equal(result.code, 1);
      assert.equal(/git tree/.test(result.stderr), false);
      assert.match(result.stderr, /download failed|fetch failed|ECONNREFUSED/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
