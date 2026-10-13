import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { asRecord } from "./disk.js";
const serverName = "poddrill";
/**
 * `package.json` one directory above the running module.
 * A `files` list that omits the skill still returns, so the owner can boot from a checkout.
 */
export async function readPackageIdentity(moduleUrl) {
    const root = dirname(dirname(fileURLToPath(moduleUrl)));
    const text = await readFile(join(root, "package.json"), "utf8");
    const identity = parseManifest(root, text);
    if (identity === undefined) {
        throw new Error(`package.json at ${root} must name ${serverName}, pin a numeric version, and pin cactusNeedle`);
    }
    return identity;
}
function parsePackageVersion(text) {
    if (!isPackageVersion(text)) {
        return undefined;
    }
    return text;
}
function isPackageVersion(text) {
    return /^\d+\.\d+\.\d+$/.test(text);
}
function parseManifest(root, text) {
    const fields = readManifestFields(text);
    if (fields === undefined) {
        return undefined;
    }
    return identityFromFields(root, fields.name, fields.version, fields.cactusNeedle, fields.files);
}
function readManifestFields(text) {
    let parsed;
    try {
        parsed = JSON.parse(text);
    }
    catch {
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
    const files = [];
    for (const entry of filesValue) {
        if (typeof entry !== "string") {
            return undefined;
        }
        files.push(entry);
    }
    return { name, version, cactusNeedle, files };
}
function identityFromFields(root, name, versionText, cactusNeedle, files) {
    const version = parsePackageVersion(versionText);
    if (name !== serverName || version === undefined || cactusNeedle.length === 0) {
        return undefined;
    }
    const spec = `${serverName}@${version}`;
    return { name: serverName, version, spec, cactusNeedle, root, files };
}
