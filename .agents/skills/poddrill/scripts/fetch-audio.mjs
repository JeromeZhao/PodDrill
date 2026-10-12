import { createWriteStream } from "node:fs";
import { mkdir, realpath, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";

export async function downloadTo(url, outputPath, expectedByteLength) {
  if (typeof url !== "string" || url.length === 0) {
    throw new Error("url must be a non-empty string");
  }
  if (typeof outputPath !== "string" || outputPath.length === 0) {
    throw new Error("output path must be a non-empty string");
  }
  const expected = readExpectedByteLength(expectedByteLength);
  const destination = await canonicalPath(outputPath);
  const root = await gitRoot();
  if (isInside(root, destination)) {
    throw new Error(`refusing to write inside the git tree: ${destination}`);
  }
  await mkdir(path.dirname(destination), { recursive: true });
  if (expected !== undefined && (await existingSize(destination)) === expected) {
    return destination;
  }
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`download failed with HTTP ${response.status}`);
  }
  if (response.body === null) {
    throw new Error("download failed with an empty body");
  }
  const partial = `${destination}.partial`;
  try {
    await pipeline(Readable.fromWeb(response.body), createWriteStream(partial));
    const written = await stat(partial);
    if (expected !== undefined && written.size !== expected) {
      throw new Error(`expected ${expected} bytes, got ${written.size}`);
    }
    await rename(partial, destination);
  } catch (error) {
    await rm(partial, { force: true });
    throw error;
  }
  return destination;
}

function readExpectedByteLength(value) {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) {
    return value;
  }
  throw new Error("expected byte length must be a positive integer");
}

async function existingSize(destination) {
  try {
    const existing = await stat(destination);
    return existing.isFile() ? existing.size : undefined;
  } catch (error) {
    if (!isEnoent(error)) {
      throw error;
    }
    return undefined;
  }
}

function isEnoent(error) {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function isInside(root, target) {
  const relative = path.relative(root, target);
  if (relative === "") {
    return true;
  }
  return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

async function gitRoot() {
  let current = path.dirname(fileURLToPath(import.meta.url));
  for (;;) {
    try {
      await stat(path.join(current, ".git"));
      return await realpath(current);
    } catch (error) {
      if (!isEnoent(error)) {
        throw error;
      }
      const parent = path.dirname(current);
      if (parent === current) {
        throw new Error("refusing to download because no git tree contains the script");
      }
      current = parent;
    }
  }
}

// A missing final component is still inside the tree when its real parent is.
async function canonicalPath(input) {
  let resolved = path.resolve(input);
  const pending = [];
  for (;;) {
    try {
      const real = await realpath(resolved);
      return pending.length === 0 ? real : path.join(real, ...pending.toReversed());
    } catch (error) {
      if (!isEnoent(error)) {
        throw error;
      }
      const parent = path.dirname(resolved);
      if (parent === resolved) {
        throw new Error(`cannot resolve ${input}`);
      }
      pending.push(path.basename(resolved));
      resolved = parent;
    }
  }
}

function parseCliByteLength(raw) {
  if (!/^[1-9][0-9]*$/.test(raw)) {
    throw new Error("expected byte length must be a positive integer");
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) {
    throw new Error("expected byte length must be a positive integer");
  }
  return value;
}

const entry = process.argv[1];
if (entry !== undefined && path.resolve(entry) === fileURLToPath(import.meta.url)) {
  const url = process.argv[2];
  const outputPath = process.argv[3];
  const rawLength = process.argv[4];
  if (url === undefined || outputPath === undefined || process.argv.length > 5) {
    console.error(
      "usage: node <path-to-this-script> <url> <output-path> [expected-bytes]",
    );
    process.exitCode = 1;
  } else {
    try {
      const expectedByteLength = rawLength === undefined ? undefined : parseCliByteLength(rawLength);
      const written = await downloadTo(url, outputPath, expectedByteLength);
      console.log(written);
    } catch (error) {
      const message = error instanceof Error ? error.message : "download failed";
      console.error(message);
      process.exitCode = 1;
    }
  }
}
