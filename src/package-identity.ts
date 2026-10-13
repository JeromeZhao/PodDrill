import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { asRecord } from "./disk.ts";

const serverName = "poddrill";

type PackageVersion = `${bigint}.${bigint}.${bigint}`;

type PoddrillSpec = `${typeof serverName}@${PackageVersion}`;

export interface PackageIdentity {
  readonly name: typeof serverName;
  readonly version: PackageVersion;
  readonly spec: PoddrillSpec;
  readonly cactusNeedle: string;
  readonly root: string;
  readonly files: readonly string[];
}

/** `package.json` one directory above the running module. */
export async function readPackageIdentity(moduleUrl: string): Promise<PackageIdentity> {
  const root = dirname(dirname(fileURLToPath(moduleUrl)));
  const text = await readFile(join(root, "package.json"), "utf8");
  const identity = parseManifest(root, text);
  if (identity === undefined) {
    throw new Error(
      `package.json at ${root} must name ${serverName}, pin a numeric version, and pin cactusNeedle`,
    );
  }
  return identity;
}

function parsePackageVersion(text: string): PackageVersion | undefined {
  if (!isPackageVersion(text)) {
    return undefined;
  }
  return text;
}

function isPackageVersion(text: string): text is PackageVersion {
  return /^\d+\.\d+\.\d+$/.test(text);
}

function parseManifest(root: string, text: string): PackageIdentity | undefined {
  const fields = readManifestFields(text);
  if (fields === undefined) {
    return undefined;
  }
  return identityFromFields(root, fields.name, fields.version, fields.cactusNeedle, fields.files);
}

function readManifestFields(text: string): {
  readonly name: string;
  readonly version: string;
  readonly cactusNeedle: string;
  readonly files: readonly string[];
} | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  const record = asRecord(parsed);
  if (record === undefined) {
    return undefined;
  }
  const name = record["name"];
  const version = record["version"];
  const cactusNeedle = record["cactusNeedle"];
  if (typeof name !== "string" || typeof version !== "string" || typeof cactusNeedle !== "string") {
    return undefined;
  }
  const filesValue = record["files"];
  if (filesValue === undefined) {
    return { name, version, cactusNeedle, files: [] };
  }
  if (!Array.isArray(filesValue)) {
    return undefined;
  }
  const files: string[] = [];
  for (const entry of filesValue) {
    if (typeof entry !== "string") {
      return undefined;
    }
    files.push(entry);
  }
  return { name, version, cactusNeedle, files };
}

function identityFromFields(
  root: string,
  name: string,
  versionText: string,
  cactusNeedle: string,
  files: readonly string[],
): PackageIdentity | undefined {
  const version = parsePackageVersion(versionText);
  if (name !== serverName || version === undefined || cactusNeedle.length === 0) {
    return undefined;
  }
  const spec: PoddrillSpec = `${serverName}@${version}`;
  return { name: serverName, version, spec, cactusNeedle, root, files };
}
