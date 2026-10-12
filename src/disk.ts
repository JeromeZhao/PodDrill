/**
 * Filesystem error codes and JSON files, read at the disk boundary.
 */

import { readFile, stat } from "node:fs/promises";

export function errorCode(error: unknown): string | undefined {
  if (error instanceof Error && "code" in error && typeof error.code === "string") {
    return error.code;
  }
  return undefined;
}

export async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (errorCode(error) === "ENOENT") {
      return false;
    }
    throw error;
  }
}

/** `undefined` when the file is missing or is not JSON. */
export async function readJsonFile(path: string): Promise<unknown> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if (errorCode(error) === "ENOENT") {
      return undefined;
    }
    throw error;
  }
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

export function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  return Object.fromEntries(Object.entries(value));
}
