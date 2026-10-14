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

export const SEGMENTATION_FILE = "segmentation.onnx";

export const SEGMENTATION_URL =
  "https://huggingface.co/onnx-community/pyannote-segmentation-3.0/resolve/733a93b6473d019a773298e08cefa686894b1854/onnx/model.onnx";

export const SEGMENTATION_BYTES = 5_986_908;

export const SEGMENTATION_SHA256 = "057ee564753071c0b09b5b611648b50ac188d50846bff5f01e9f7bbf1591ea25";

export const SEGMENTATION_LICENSE = "MIT";

export const SEGMENTATION_ATTRIBUTION = "pyannote segmentation-3.0 powerset model. MIT license.";

export const FETCH_WEIGHTS_FIX = "poddrill fetch-weights";

export interface WeightSpec {
  readonly bytes: number;
  readonly sha256: string;
}

export const ecapaSpec: WeightSpec = { bytes: ECAPA_BYTES, sha256: ECAPA_SHA256 };

export const segmentationSpec: WeightSpec = { bytes: SEGMENTATION_BYTES, sha256: SEGMENTATION_SHA256 };

export type DigestStatus = "missing" | "match" | "mismatch";

export interface FetchWeightsResult {
  readonly path: string;
  readonly created: boolean;
  readonly bytes: number;
  readonly sha256: string;
  readonly license: string;
  readonly attribution: string;
}

export interface FetchedWeights {
  readonly ecapa: FetchWeightsResult;
  readonly segmentation: FetchWeightsResult;
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

interface PinnedWeight {
  readonly label: string;
  readonly url: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly license: string;
  readonly attribution: string;
}

const ecapaPin: PinnedWeight = {
  label: "ECAPA",
  url: ECAPA_URL,
  bytes: ECAPA_BYTES,
  sha256: ECAPA_SHA256,
  license: ECAPA_LICENSE,
  attribution: ECAPA_ATTRIBUTION,
};

const segmentationPin: PinnedWeight = {
  label: "segmentation",
  url: SEGMENTATION_URL,
  bytes: SEGMENTATION_BYTES,
  sha256: SEGMENTATION_SHA256,
  license: SEGMENTATION_LICENSE,
  attribution: SEGMENTATION_ATTRIBUTION,
};

export async function fetchWeights(ecapaPath: string, segmentationPath: string): Promise<FetchedWeights> {
  return {
    ecapa: await fetchPinned(ecapaPath, ecapaPin),
    segmentation: await fetchPinned(segmentationPath, segmentationPin),
  };
}

async function fetchPinned(destination: string, pinned: PinnedWeight): Promise<FetchWeightsResult> {
  const status = await digestStatus(destination, { bytes: pinned.bytes, sha256: pinned.sha256 });
  if (status === "match") {
    return weightsResult(destination, false, pinned);
  }
  await mkdir(dirname(destination), { recursive: true });
  const partial = `${destination}.partial`;
  try {
    const response = await fetch(pinned.url, { headers: { "user-agent": "poddrill" } });
    if (!response.ok) {
      throw new Error(`${pinned.label} download failed with HTTP ${response.status}`);
    }
    if (response.body === null) {
      throw new Error(`${pinned.label} download failed with an empty body`);
    }
    await pipeline(Readable.fromWeb(response.body), createWriteStream(partial));
    const written = await stat(partial);
    if (written.size !== pinned.bytes) {
      throw new Error(`${pinned.label} download expected ${pinned.bytes} bytes, got ${written.size}`);
    }
    const sha256 = await sha256File(partial);
    if (sha256 !== pinned.sha256) {
      throw new Error(`${pinned.label} download sha256 ${sha256} does not match ${pinned.sha256}`);
    }
    await rename(partial, destination);
  } catch (error: unknown) {
    await rm(partial, { force: true });
    throw error;
  }
  return weightsResult(destination, true, pinned);
}

function weightsResult(path: string, created: boolean, pinned: PinnedWeight): FetchWeightsResult {
  return {
    path,
    created,
    bytes: pinned.bytes,
    sha256: pinned.sha256,
    license: pinned.license,
    attribution: pinned.attribution,
  };
}
