/**
 * Pinned WeSpeaker ECAPA-TDNN512 weights.
 * The model card has no license field. WeSpeaker docs say pretrained models follow
 * the dataset license, and VoxCeleb is CC BY 4.0, so attribution stays with the file.
 */

import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, rename, rm, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

import { errorCode } from "./disk.ts";

export const ECAPA_FILE = "voxceleb_ECAPA512.onnx";

export const ECAPA_URL =
  "https://huggingface.co/Wespeaker/wespeaker-voxceleb-ecapa-tdnn512/resolve/89426e111abc9ffcc40279baf808e087693c6e9b/voxceleb_ECAPA512.onnx";

export const ECAPA_BYTES = 24_861_931;

export const ECAPA_SHA256 = "f901ae3571912bad4e11e157744cb8b7d77a0b46923b83c410bdbb6c77d69736";

export const ECAPA_LICENSE = "CC BY 4.0";

export const ECAPA_ATTRIBUTION =
  "WeSpeaker ECAPA-TDNN512 pretrained on VoxCeleb. VoxCeleb is used under CC BY 4.0.";

export const FETCH_WEIGHTS_FIX = "poddrill fetch-weights";

export interface WeightSpec {
  readonly bytes: number;
  readonly sha256: string;
}

export const ecapaSpec: WeightSpec = { bytes: ECAPA_BYTES, sha256: ECAPA_SHA256 };

export type DigestStatus = "missing" | "match" | "mismatch";

export interface FetchWeightsResult {
  readonly path: string;
  readonly created: boolean;
  readonly bytes: number;
  readonly sha256: string;
  readonly license: typeof ECAPA_LICENSE;
  readonly attribution: typeof ECAPA_ATTRIBUTION;
}

export async function digestStatus(path: string, spec: WeightSpec): Promise<DigestStatus> {
  let info: { size: number; isFile: () => boolean };
  try {
    info = await stat(path);
  } catch (error: unknown) {
    if (errorCode(error) === "ENOENT") {
      return "missing";
    }
    throw error;
  }
  if (!info.isFile() || info.size !== spec.bytes) {
    return "mismatch";
  }
  const sha256 = await sha256File(path);
  return sha256 === spec.sha256 ? "match" : "mismatch";
}

export async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  const stream = createReadStream(path);
  for await (const chunk of stream) {
    hash.update(chunk);
  }
  return hash.digest("hex");
}

/** Download the pinned file when the destination is missing or does not match. Idempotent. */
export async function fetchEcapa(destination: string): Promise<FetchWeightsResult> {
  const status = await digestStatus(destination, ecapaSpec);
  if (status === "match") {
    return weightsResult(destination, false);
  }
  await mkdir(dirname(destination), { recursive: true });
  const partial = `${destination}.partial`;
  try {
    const response = await fetch(ECAPA_URL, { headers: { "user-agent": "poddrill" } });
    if (!response.ok) {
      throw new Error(`ECAPA download failed with HTTP ${response.status}`);
    }
    if (response.body === null) {
      throw new Error("ECAPA download failed with an empty body");
    }
    await pipeline(Readable.fromWeb(response.body), createWriteStream(partial));
    const written = await stat(partial);
    if (written.size !== ECAPA_BYTES) {
      throw new Error(`ECAPA download expected ${ECAPA_BYTES} bytes, got ${written.size}`);
    }
    const sha256 = await sha256File(partial);
    if (sha256 !== ECAPA_SHA256) {
      throw new Error(`ECAPA download sha256 ${sha256} does not match ${ECAPA_SHA256}`);
    }
    await rename(partial, destination);
  } catch (error: unknown) {
    await rm(partial, { force: true });
    throw error;
  }
  return weightsResult(destination, true);
}

function weightsResult(path: string, created: boolean): FetchWeightsResult {
  return {
    path,
    created,
    bytes: ECAPA_BYTES,
    sha256: ECAPA_SHA256,
    license: ECAPA_LICENSE,
    attribution: ECAPA_ATTRIBUTION,
  };
}
