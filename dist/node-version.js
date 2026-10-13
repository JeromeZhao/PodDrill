/**
 * The published CLI runs on Node 20.19 and newer.
 * Tests use `node --experimental-strip-types`, which this floor does not promise.
 */
export const MIN_NODE = "20.19.0";
export function nodeMeetsMinimum(version, minimum = MIN_NODE) {
    const actual = parseNode(version);
    const floor = parseNode(minimum);
    if (actual === undefined || floor === undefined) {
        return false;
    }
    for (let index = 0; index < 3; index += 1) {
        const left = actual[index] ?? 0;
        const right = floor[index] ?? 0;
        if (left > right) {
            return true;
        }
        if (left < right) {
            return false;
        }
    }
    return true;
}
/** One sentence a failing doctor check and the CLI preflight can both print. */
export function nodeInstallMessage(found) {
    const shown = found.startsWith("v") ? found : `v${found}`;
    return [
        `poddrill needs Node >=${MIN_NODE}, found ${shown}.`,
        "Install the .tar.gz archive, not .tar.xz,",
        `from https://nodejs.org/dist/v${MIN_NODE}/ or run npx -y node@${MIN_NODE}.`,
    ].join(" ");
}
export function nodeFixCommand() {
    return `npx -y node@${MIN_NODE}`;
}
function parseNode(version) {
    const stripped = version.startsWith("v") ? version.slice(1) : version;
    const parts = stripped.split(".");
    if (parts.length < 2) {
        return undefined;
    }
    const numbers = [];
    for (let index = 0; index < 3; index += 1) {
        const part = parts[index] ?? "0";
        const match = /^(\d+)/.exec(part);
        const digits = match?.[1];
        if (digits === undefined) {
            return undefined;
        }
        numbers.push(Number(digits));
    }
    const major = numbers[0];
    const minor = numbers[1];
    const patch = numbers[2];
    if (major === undefined || minor === undefined || patch === undefined) {
        return undefined;
    }
    return [major, minor, patch];
}
