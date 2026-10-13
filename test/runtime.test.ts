import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { nodeMeetsMinimum } from "../src/node-version.ts";
import { chooseInstaller, NUMPY_PIN, ONNXRUNTIME_PIN } from "../src/python-env.ts";
import { digestStatus, sha256File } from "../src/weights.ts";

describe("node floor", () => {
  it("accepts 20.19 and newer and rejects 20.18", () => {
    assert.equal(nodeMeetsMinimum("20.19.0"), true);
    assert.equal(nodeMeetsMinimum("v20.19.0"), true);
    assert.equal(nodeMeetsMinimum("20.19"), true);
    assert.equal(nodeMeetsMinimum("22.14.0"), true);
    assert.equal(nodeMeetsMinimum("20.18.9"), false);
    assert.equal(nodeMeetsMinimum("18.20.0"), false);
    assert.equal(nodeMeetsMinimum("not-a-version"), false);
  });
});

describe("python installer", () => {
  it("uses uv when it is on PATH and the stdlib venv otherwise", () => {
    assert.equal(chooseInstaller(true), "uv");
    assert.equal(chooseInstaller(false), "venv");
  });

  it("keeps requirements.txt on the same pins as the installer", async () => {
    const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")) as unknown;
    assert.equal(typeof manifest, "object");
    if (typeof manifest !== "object" || manifest === null || Array.isArray(manifest)) {
      return;
    }
    const record: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(manifest)) {
      record[key] = value;
    }
    const needle = record["cactusNeedle"];
    assert.equal(typeof needle, "string");
    const text = await readFile(new URL("../requirements.txt", import.meta.url), "utf8");
    assert.equal(
      text,
      [`cactus-needle==${String(needle)}`, `numpy==${NUMPY_PIN}`, `onnxruntime==${ONNXRUNTIME_PIN}`, ""].join("\n"),
    );
  });
});

describe("weight digest", () => {
  it("matches a file with the expected size and sha256 and rejects any other bytes", async () => {
    const dir = await mkdtemp(join(tmpdir(), "poddrill-weights-"));
    try {
      const path = join(dir, "file.bin");
      await writeFile(path, "hello");
      const sha256 = await sha256File(path);
      assert.equal(sha256, "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824");
      assert.equal(await digestStatus(path, { bytes: 5, sha256 }), "match");
      assert.equal(await digestStatus(path, { bytes: 4, sha256 }), "mismatch");
      assert.equal(await digestStatus(join(dir, "missing.bin"), { bytes: 5, sha256 }), "missing");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
