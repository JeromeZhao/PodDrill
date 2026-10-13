import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { cp, mkdir, readdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, normalize, relative } from "node:path";
import { asRecord, errorCode, pathExists } from "./disk.js";
import { embedWeightsPath } from "./embed.js";
import { readPackageIdentity } from "./package-identity.js";
const serverName = "poddrill";
const skillPublishPath = `.agents/skills/${serverName}`;
const skillNextPrefix = `${serverName}.next-`;
const skillPrevPrefix = `${serverName}.prev-`;
const skillMarkerSuffix = ".complete";
const requiredPublishedFiles = ["dist", skillPublishPath];
const GROK_STARTUP_TIMEOUT_SEC = 30;
const CONFIG_CAS_LIMIT = 5;
const clientIds = ["cursor", "grok_build", "grok_bot"];
const clientIdList = clientIds.join("|");
export const clientUsageBody = [
    `client doctor --client <${clientIdList}> [--json]`,
    `client plan --client <${clientIdList}> [--json]`,
    `client plan --linked [--json]`,
    `client apply --yes --client <${clientIdList}> [--json]`,
    `client apply --yes --linked [--json]`,
].join(" | ");
const clientUsage = `usage: poddrill ${clientUsageBody}`;
const workspaceCommandMessage = "poddrill client registers Cursor or Grok. A workspace is poddrill setup --provider <id> --queue-length <n>.";
export function workspaceSetupCollision(args) {
    for (const flag of ["--client", "--linked", "--yes", "--dry-run"]) {
        if (args.includes(flag)) {
            return `poddrill setup writes a workspace. Register a client with: ${clientUsage}`;
        }
    }
    return undefined;
}
export async function clientMain(args, env, moduleUrl) {
    const parsed = parseClientArgs(args);
    if (!parsed.ok) {
        return { text: errorText(parsed.message), exitCode: 1 };
    }
    const home = absoluteHome(env);
    if (home === undefined) {
        return outcomeRendered({
            kind: "refused",
            reason: "home-missing",
            message: "HOME must be an absolute path",
        });
    }
    const identity = await readPackageIdentity(moduleUrl);
    if (!publishLayoutOk(identity.files)) {
        return outcomeRendered({
            kind: "refused",
            reason: "package-identity",
            message: `package.json files must include ${requiredPublishedFiles.join(" and ")}`,
        });
    }
    switch (parsed.command.op) {
        case "doctor":
            return outcomeRendered(await doctor(parsed.command.client, identity, home, env));
        case "plan":
            return outcomeRendered(await resolve(parsed.command.selection, identity, home));
        case "apply":
            return outcomeRendered(await applyResolved(await resolve(parsed.command.selection, identity, home), identity, home));
        default: {
            const leftover = parsed.command;
            throw new Error(`unexpected command ${JSON.stringify(leftover)}`);
        }
    }
}
async function doctor(client, identity, home, env) {
    const launcher = launcherFor(identity.spec);
    const paths = pathsFor(home);
    const skillText = await readOptionalUtf8(join(identity.root, skillPublishPath, "SKILL.md"));
    const probes = await runtimeProbes(env, identity);
    const link = await linkCheckFor(client, paths, launcher);
    return {
        kind: "doctor",
        client,
        launcher,
        checks: [skillBundleCheck(skillText), probes[0], probes[1], probes[2], link],
    };
}
async function resolve(selection, identity, home) {
    const launcher = launcherFor(identity.spec);
    const skillPath = join(identity.root, skillPublishPath, "SKILL.md");
    const skillText = await readOptionalUtf8(skillPath);
    if (skillText === undefined) {
        return {
            kind: "refused",
            reason: "skill-bundle-missing",
            path: skillPath,
            message: `bundled skill is missing at ${skillPath}`,
        };
    }
    if (!skillAgrees(skillText)) {
        return {
            kind: "refused",
            reason: "skill-pin-mismatch",
            path: skillPath,
            message: "bundled skill must name client doctor, client plan, and client apply --yes, and must not include @latest or an unpinned npx launch",
        };
    }
    const paths = pathsFor(home);
    const effects = await effectsFor(selection, launcher, paths);
    if (effects === undefined) {
        return { kind: "nothing-linked", launcher };
    }
    const bundle = bundleDir(identity);
    const view = await observeSkill(paths.skillDest, bundle);
    return {
        kind: "plan",
        launcher,
        skill: { dest: paths.skillDest, action: skillAction(view) },
        effects,
    };
}
async function applyResolved(resolved, identity, home) {
    switch (resolved.kind) {
        case "nothing-linked":
        case "refused":
            return resolved;
        case "plan":
            return commit(resolved, identity, home);
        default: {
            const leftover = resolved;
            throw new Error(`unexpected resolution ${JSON.stringify(leftover)}`);
        }
    }
}
async function commit(plan, identity, home) {
    const blocked = firstUnreadable(plan.effects);
    if (blocked !== undefined) {
        return blocked;
    }
    if (!(await staysInHome(home, plan.skill.dest))) {
        return {
            kind: "refused",
            reason: "outside-home",
            path: plan.skill.dest,
            message: `refusing to write ${plan.skill.dest}`,
        };
    }
    const skillError = await convergeSkill(plan.skill.dest, bundleDir(identity));
    if (skillError !== undefined) {
        return skillError;
    }
    const results = [];
    for (const effect of plan.effects) {
        const written = await writeEffect(effect, plan.launcher, home);
        if ("kind" in written) {
            return written;
        }
        results.push(written);
    }
    const verified = await verify(plan, identity);
    if (verified !== undefined) {
        return verified;
    }
    return {
        kind: "applied",
        launcher: plan.launcher,
        skill: plan.skill.action,
        results,
    };
}
function parseClientArgs(args) {
    const opText = args[0];
    if (opText === undefined) {
        return fail(clientUsage);
    }
    const op = parseOp(opText);
    if (op === undefined) {
        return fail(clientUsage);
    }
    let jsonCount = 0;
    let yes = false;
    let linked = false;
    let client;
    for (let index = 1; index < args.length; index += 1) {
        const arg = args[index];
        if (arg === undefined) {
            continue;
        }
        if (arg === "--provider" || arg === "--queue-length") {
            return fail(workspaceCommandMessage);
        }
        switch (arg) {
            case "--json":
                jsonCount += 1;
                if (jsonCount > 1) {
                    return fail(clientUsage);
                }
                break;
            case "--yes":
                if (yes) {
                    return fail(clientUsage);
                }
                yes = true;
                break;
            case "--linked":
                if (linked) {
                    return fail(clientUsage);
                }
                linked = true;
                break;
            case "--dry-run":
                return fail("client plan is the preview. poddrill client has no --dry-run flag.");
            case "--client": {
                if (client !== undefined) {
                    return fail(clientUsage);
                }
                const value = args[index + 1];
                if (value === undefined || value.startsWith("--")) {
                    return fail(clientUsage);
                }
                const parsed = parseClientId(value);
                if (parsed === undefined) {
                    return fail(clientUsage);
                }
                client = parsed;
                index += 1;
                break;
            }
            default:
                return fail(clientUsage);
        }
    }
    if (yes && op !== "apply") {
        return fail("client plan does not write. client apply --yes writes.");
    }
    if (!yes && op === "apply") {
        return fail("client apply writes nothing without --yes. client plan previews.");
    }
    const command = commandFrom(op, client, linked);
    if (command === undefined) {
        return fail(clientUsage);
    }
    return { ok: true, command };
}
function commandFrom(op, client, linked) {
    if (linked && client !== undefined) {
        return undefined;
    }
    switch (op) {
        case "doctor":
            if (linked || client === undefined) {
                return undefined;
            }
            return { op: "doctor", client };
        case "plan":
            if (linked) {
                return { op: "plan", selection: { kind: "linked" } };
            }
            if (client === undefined) {
                return undefined;
            }
            return { op: "plan", selection: { kind: "one", client } };
        case "apply":
            if (linked) {
                return { op: "apply", selection: { kind: "linked" } };
            }
            if (client === undefined) {
                return undefined;
            }
            return { op: "apply", selection: { kind: "one", client } };
        default: {
            const leftover = op;
            throw new Error(`unexpected op ${String(leftover)}`);
        }
    }
}
function parseOp(value) {
    switch (value) {
        case "doctor":
        case "plan":
        case "apply":
            return value;
        default:
            return undefined;
    }
}
function parseClientId(value) {
    for (const client of clientIds) {
        if (client === value) {
            return client;
        }
    }
    return undefined;
}
function fail(message) {
    return { ok: false, message };
}
function absoluteHome(env) {
    const raw = env["HOME"];
    const home = raw === undefined || raw === "" ? homedir() : raw;
    if (!isAbsolute(home)) {
        return undefined;
    }
    return home;
}
function publishLayoutOk(files) {
    for (const required of requiredPublishedFiles) {
        if (!files.includes(required)) {
            return false;
        }
    }
    return true;
}
function launcherFor(spec) {
    return { command: "npx", args: ["-y", spec, "mcp"] };
}
function bundleDir(identity) {
    return join(identity.root, skillPublishPath);
}
function grokBotSentence(launcher) {
    const commandLine = [launcher.command, ...launcher.args].join(" ");
    return `Add a custom server named ${serverName} on this computer, running ${commandLine}.`;
}
function skillAgrees(skillText) {
    if (skillText.includes(`${serverName}@latest`) || skillText.includes(`npx -y ${serverName} `)) {
        return false;
    }
    return (skillText.includes("client doctor") &&
        skillText.includes("client plan") &&
        skillText.includes("client apply --yes"));
}
function skillBundleCheck(text) {
    if (text !== undefined && skillAgrees(text)) {
        return { name: "skill-bundle", state: "ok" };
    }
    const detail = text === undefined
        ? "bundled SKILL.md is missing"
        : "bundled SKILL.md does not name the client commands";
    return { name: "skill-bundle", state: "bad", detail };
}
function writingClients() {
    const found = [];
    for (const client of clientIds) {
        switch (client) {
            case "cursor":
            case "grok_build":
                found.push(client);
                break;
            case "grok_bot":
                break;
            default: {
                const leftover = client;
                throw new Error(`unexpected client ${String(leftover)}`);
            }
        }
    }
    return found;
}
function pathsFor(home) {
    return {
        skillDest: join(home, skillPublishPath),
        cursorMcp: join(home, ".cursor", "mcp.json"),
        grokConfig: join(home, ".grok", "config.toml"),
    };
}
function configFormat(client) {
    switch (client) {
        case "cursor":
            return "json";
        case "grok_build":
            return "toml";
        default: {
            const leftover = client;
            throw new Error(`unexpected writer ${String(leftover)}`);
        }
    }
}
function skillAction(view) {
    switch (view.live) {
        case "match":
            return "keep";
        case "absent":
            return view.completeNext.length > 0 ? "finish" : "install";
        case "differ":
            return "replace";
        default: {
            const leftover = view.live;
            throw new Error(`unexpected live ${String(leftover)}`);
        }
    }
}
function nextSkillStep(view) {
    const partial = view.partialNext[0];
    if (partial !== undefined) {
        return { op: "drop", path: partial };
    }
    const orphan = view.orphanMarkers[0];
    if (orphan !== undefined) {
        return { op: "drop", path: orphan };
    }
    switch (view.live) {
        case "match": {
            const extra = view.completeNext[0] ?? view.prev[0];
            if (extra !== undefined) {
                return { op: "drop", path: extra };
            }
            return { op: "done" };
        }
        case "absent": {
            const ready = view.completeNext[0];
            if (ready !== undefined) {
                return { op: "promote", path: ready };
            }
            return { op: "stage" };
        }
        case "differ":
            if (view.completeNext[0] === undefined) {
                return { op: "stage" };
            }
            return { op: "aside" };
        default: {
            const leftover = view.live;
            throw new Error(`unexpected live ${String(leftover)}`);
        }
    }
}
function skillStepBudget(view) {
    // Stage, aside, and promote leave a marker and a prev that this first view cannot count.
    return (view.partialNext.length +
        view.completeNext.length +
        view.prev.length +
        view.orphanMarkers.length +
        6);
}
function pathStaysInHome(home, candidate) {
    const root = normalize(home);
    const target = normalize(candidate);
    const rootPrefix = root.endsWith("/") ? root : `${root}/`;
    return target === root || target.startsWith(rootPrefix);
}
function markerPath(dir) {
    return `${dir}${skillMarkerSuffix}`;
}
function firstUnreadable(effects) {
    for (const effect of effects) {
        const refusal = unreadable(effect);
        if (refusal !== undefined) {
            return refusal;
        }
    }
    return undefined;
}
function unreadable(effect) {
    switch (effect.client) {
        case "grok_bot":
            return undefined;
        case "cursor":
        case "grok_build":
            if (effect.record.status !== "unreadable") {
                return undefined;
            }
            return {
                kind: "refused",
                reason: "unreadable-config",
                path: effect.path,
                message: effect.record.detail,
            };
        default: {
            const leftover = effect;
            throw new Error(`unexpected effect ${JSON.stringify(leftover)}`);
        }
    }
}
function unchangedEffect(effect) {
    switch (effect.client) {
        case "cursor":
            return { client: "cursor", path: effect.path, result: "unchanged" };
        case "grok_build":
            return {
                client: "grok_build",
                path: effect.path,
                result: "unchanged",
                startupTimeoutSec: effect.startupTimeoutSec,
            };
        default: {
            const leftover = effect;
            throw new Error(`unexpected effect ${JSON.stringify(leftover)}`);
        }
    }
}
async function effectsFor(selection, launcher, paths) {
    switch (selection.kind) {
        case "one":
            return [await oneEffect(selection.client, launcher, paths)];
        case "linked": {
            const effects = [];
            for (const client of writingClients()) {
                const effect = await writingEffect(client, launcher, paths);
                if (effect.record.status === "absent") {
                    continue;
                }
                effects.push(effect);
            }
            if (effects.length === 0) {
                return undefined;
            }
            return effects;
        }
        default: {
            const leftover = selection;
            throw new Error(`unexpected selection ${JSON.stringify(leftover)}`);
        }
    }
}
async function oneEffect(client, launcher, paths) {
    switch (client) {
        case "cursor":
        case "grok_build":
            return writingEffect(client, launcher, paths);
        case "grok_bot":
            return { client: "grok_bot", sentence: grokBotSentence(launcher) };
        default: {
            const leftover = client;
            throw new Error(`unexpected client ${String(leftover)}`);
        }
    }
}
async function writingEffect(client, launcher, paths) {
    switch (client) {
        case "cursor":
            return {
                client,
                path: paths.cursorMcp,
                record: await linkRecord(paths.cursorMcp, "json", launcher),
            };
        case "grok_build":
            return {
                client,
                path: paths.grokConfig,
                record: await linkRecord(paths.grokConfig, "toml", launcher),
                startupTimeoutSec: GROK_STARTUP_TIMEOUT_SEC,
            };
        default: {
            const leftover = client;
            throw new Error(`unexpected writer ${String(leftover)}`);
        }
    }
}
async function linkCheckFor(client, paths, launcher) {
    switch (client) {
        case "grok_bot":
            return { name: "link", client, sentence: grokBotSentence(launcher) };
        case "cursor":
        case "grok_build": {
            const effect = await writingEffect(client, launcher, paths);
            return { name: "link", client, record: effect.record };
        }
        default: {
            const leftover = client;
            throw new Error(`unexpected client ${String(leftover)}`);
        }
    }
}
async function convergeSkill(dest, bundle) {
    let view = await observeSkill(dest, bundle);
    const budget = skillStepBudget(view);
    for (let step = 0; step < budget; step += 1) {
        const next = nextSkillStep(view);
        if (next.op === "done") {
            return undefined;
        }
        await runSkillStep(dest, bundle, next);
        view = await observeSkill(dest, bundle);
    }
    if (nextSkillStep(view).op === "done") {
        return undefined;
    }
    return {
        kind: "refused",
        reason: "skill-mismatch",
        message: `skill at ${dest} did not match the bundle`,
    };
}
async function verify(plan, identity) {
    const view = await observeSkill(plan.skill.dest, bundleDir(identity));
    if (view.live !== "match" ||
        view.partialNext.length > 0 ||
        view.completeNext.length > 0 ||
        view.prev.length > 0 ||
        view.orphanMarkers.length > 0) {
        return {
            kind: "refused",
            reason: "skill-mismatch",
            message: `skill at ${plan.skill.dest} does not match the bundle`,
        };
    }
    for (const effect of plan.effects) {
        switch (effect.client) {
            case "grok_bot":
                break;
            case "cursor":
            case "grok_build": {
                const record = await linkRecord(effect.path, configFormat(effect.client), plan.launcher);
                if (record.status !== "match") {
                    return {
                        kind: "refused",
                        reason: "config-race",
                        message: `${effect.path} does not match the launcher`,
                    };
                }
                break;
            }
            default: {
                const leftover = effect;
                throw new Error(`unexpected effect ${JSON.stringify(leftover)}`);
            }
        }
    }
    return undefined;
}
async function writeEffect(effect, launcher, home) {
    switch (effect.client) {
        case "grok_bot":
            return { client: "grok_bot", sentence: effect.sentence };
        case "cursor":
        case "grok_build": {
            if (!(await staysInHome(home, effect.path))) {
                return {
                    kind: "refused",
                    reason: "outside-home",
                    path: effect.path,
                    message: `refusing to write ${effect.path}`,
                };
            }
            if (effect.record.status === "match") {
                return unchangedEffect(effect);
            }
            const swapped = await compareAndSwap(effect.path, configFormat(effect.client), launcher);
            if (typeof swapped !== "string") {
                return swapped;
            }
            return swapped === "unchanged" ? unchangedEffect(effect) : writtenEffect(effect);
        }
        default: {
            const leftover = effect;
            throw new Error(`unexpected effect ${JSON.stringify(leftover)}`);
        }
    }
}
function writtenEffect(effect) {
    switch (effect.client) {
        case "cursor":
            return { client: "cursor", path: effect.path, result: "written" };
        case "grok_build":
            return {
                client: "grok_build",
                path: effect.path,
                result: "written",
                startupTimeoutSec: effect.startupTimeoutSec,
            };
        default: {
            const leftover = effect;
            throw new Error(`unexpected effect ${JSON.stringify(leftover)}`);
        }
    }
}
function checkFailed(check) {
    switch (check.name) {
        case "skill-bundle":
        case "ffmpeg":
        case "cactus-needle":
        case "ecapa":
            return check.state === "bad";
        case "link":
            return linkFailed(check);
        default: {
            const leftover = check;
            throw new Error(`unexpected check ${JSON.stringify(leftover)}`);
        }
    }
}
function linkFailed(check) {
    switch (check.client) {
        case "grok_bot":
            return false;
        case "cursor":
        case "grok_build":
            return check.record.status !== "match";
        default: {
            const leftover = check;
            throw new Error(`unexpected link ${JSON.stringify(leftover)}`);
        }
    }
}
function exitCode(outcome) {
    switch (outcome.kind) {
        case "plan":
        case "applied":
        case "nothing-linked":
            return 0;
        case "refused":
            return 1;
        case "doctor":
            return outcome.checks.some((check) => checkFailed(check)) ? 1 : 0;
        default: {
            const leftover = outcome;
            throw new Error(`unexpected outcome ${JSON.stringify(leftover)}`);
        }
    }
}
function outcomeRendered(outcome) {
    return { text: `${JSON.stringify(outcome)}\n`, exitCode: exitCode(outcome) };
}
function errorText(message) {
    const body = { kind: "error", message };
    return `${JSON.stringify(body)}\n`;
}
async function readOptionalUtf8(path) {
    try {
        return await readFile(path, "utf8");
    }
    catch (error) {
        if (errorCode(error) === "ENOENT") {
            return undefined;
        }
        throw error;
    }
}
async function runtimeProbes(env, identity) {
    const ffmpeg = await ffmpegCheck(env);
    const needle = await needleCheck(env, identity.cactusNeedle);
    const weights = embedWeightsPath(env);
    const ecapa = (await pathExists(weights))
        ? { name: "ecapa", state: "ok", path: weights }
        : { name: "ecapa", state: "bad", path: weights };
    return [ffmpeg, needle, ecapa];
}
async function ffmpegCheck(env) {
    const result = await capture("ffmpeg", ["-version"], env);
    if (result.code === 0) {
        return { name: "ffmpeg", state: "ok" };
    }
    return { name: "ffmpeg", state: "bad", detail: "ffmpeg is not on PATH" };
}
async function needleCheck(env, expected) {
    const result = await capture("python3", ["-c", "import needle\nprint(needle.__version__)\n"], env);
    if (result.code !== 0) {
        return { name: "cactus-needle", state: "bad", expected, found: undefined };
    }
    const found = result.stdout.trim();
    if (found === expected) {
        return { name: "cactus-needle", state: "ok", version: found };
    }
    return { name: "cactus-needle", state: "bad", expected, found };
}
function capture(command, args, env) {
    return new Promise((resolve, reject) => {
        const child = spawn(command, [...args], {
            env: spawnEnv(env),
            stdio: ["ignore", "pipe", "pipe"],
        });
        const out = [];
        child.stdout.on("data", (chunk) => {
            out.push(chunk);
        });
        child.on("error", (error) => {
            if (errorCode(error) === "ENOENT") {
                resolve({ code: null, stdout: "" });
                return;
            }
            reject(error);
        });
        child.on("close", (code) => {
            resolve({ code, stdout: Buffer.concat(out).toString("utf8") });
        });
    });
}
function spawnEnv(env) {
    const copy = {};
    for (const [key, value] of Object.entries(env)) {
        if (value !== undefined) {
            copy[key] = value;
        }
    }
    return copy;
}
async function linkRecord(path, format, launcher) {
    const text = await readOptionalUtf8(path);
    switch (format) {
        case "json":
            return cursorRecord(text, launcher);
        case "toml":
            return grokRecord(text, launcher);
        default: {
            const leftover = format;
            throw new Error(`unexpected format ${String(leftover)}`);
        }
    }
}
function cursorRecord(text, launcher) {
    if (text === undefined || text.trim() === "") {
        return { status: "absent" };
    }
    let parsed;
    try {
        parsed = JSON.parse(text);
    }
    catch {
        return { status: "unreadable", detail: "mcp.json is not valid JSON" };
    }
    const root = asRecord(parsed);
    if (root === undefined) {
        return { status: "unreadable", detail: "mcp.json must be a JSON object" };
    }
    if (!Object.prototype.hasOwnProperty.call(root, "mcpServers")) {
        return { status: "absent" };
    }
    const servers = asRecord(root["mcpServers"]);
    if (servers === undefined) {
        return { status: "unreadable", detail: "mcpServers is not an object" };
    }
    if (!Object.prototype.hasOwnProperty.call(servers, serverName)) {
        return { status: "absent" };
    }
    const entry = servers[serverName];
    if (cursorEntryMatches(entry, launcher)) {
        return { status: "match" };
    }
    return { status: "differ", previous: previousFromCursor(entry) };
}
function cursorEntryMatches(value, launcher) {
    const record = asRecord(value);
    if (record === undefined) {
        return false;
    }
    const keys = Object.keys(record);
    if (keys.length !== 2 || !keys.includes("command") || !keys.includes("args")) {
        return false;
    }
    if (record["command"] !== launcher.command) {
        return false;
    }
    const args = stringList(record["args"]);
    if (args === undefined) {
        return false;
    }
    return sameStrings(args, launcher.args);
}
function previousFromCursor(value) {
    const record = asRecord(value);
    if (record === undefined) {
        return { command: "", args: [] };
    }
    const command = typeof record["command"] === "string" ? record["command"] : "";
    return { command, args: stringList(record["args"]) ?? [] };
}
function stringList(value) {
    if (!Array.isArray(value)) {
        return undefined;
    }
    const args = [];
    for (const entry of value) {
        if (typeof entry !== "string") {
            return undefined;
        }
        args.push(entry);
    }
    return args;
}
function sameStrings(actual, expected) {
    if (actual.length !== expected.length) {
        return false;
    }
    for (let index = 0; index < expected.length; index += 1) {
        if (actual[index] !== expected[index]) {
            return false;
        }
    }
    return true;
}
function grokRecord(text, launcher) {
    if (text === undefined || text.trim() === "") {
        return { status: "absent" };
    }
    const sections = scanTomlSections(text);
    if (sections === undefined) {
        return { status: "unreadable", detail: "config.toml headers cannot be scanned" };
    }
    const hits = sections.filter((section) => isPoddrillTable(section.name));
    if (hits.length > 1) {
        return { status: "unreadable", detail: "config.toml has more than one poddrill table" };
    }
    const hit = hits[0];
    if (hit === undefined) {
        return { status: "absent" };
    }
    const previous = previousFromToml(hit.body);
    if (grokBodyMatches(hit.body, launcher, previous)) {
        return { status: "match" };
    }
    return { status: "differ", previous };
}
function grokBodyMatches(body, launcher, previous) {
    if (!("startupTimeoutSec" in previous)) {
        return false;
    }
    const keys = assignmentKeys(body);
    if (keys === undefined) {
        return false;
    }
    if (keys.length !== 3 || !keys.includes("command") || !keys.includes("args") || !keys.includes("startup_timeout_sec")) {
        return false;
    }
    return (previous.command === launcher.command &&
        sameStrings(previous.args, launcher.args) &&
        previous.startupTimeoutSec === GROK_STARTUP_TIMEOUT_SEC);
}
function previousFromToml(body) {
    let command = "";
    let args = [];
    let startupTimeoutSec = null;
    for (const line of body.split("\n")) {
        const commandMatch = /^\s*command\s*=\s*"((?:\\.|[^"\\])*)"\s*(?:#.*)?$/.exec(line);
        if (commandMatch !== null) {
            command = unescapeToml(commandMatch[1] ?? "");
            continue;
        }
        const argsMatch = /^\s*args\s*=\s*\[(.*)\]\s*(?:#.*)?$/.exec(line);
        if (argsMatch !== null) {
            const parsed = parseTomlStringArray(argsMatch[1] ?? "");
            if (parsed !== undefined) {
                args = parsed;
            }
            continue;
        }
        const timeoutMatch = /^\s*startup_timeout_sec\s*=\s*(\d+)\s*(?:#.*)?$/.exec(line);
        if (timeoutMatch !== null && timeoutMatch[1] !== undefined) {
            startupTimeoutSec = Number(timeoutMatch[1]);
        }
    }
    return { command, args, startupTimeoutSec };
}
function assignmentKeys(body) {
    const keys = [];
    for (const line of body.split("\n")) {
        const trimmed = line.trim();
        if (trimmed === "" || trimmed.startsWith("#")) {
            continue;
        }
        const match = /^([A-Za-z0-9_-]+)\s*=/.exec(trimmed);
        const key = match?.[1];
        if (key === undefined) {
            return undefined;
        }
        keys.push(key);
    }
    return keys;
}
function parseTomlStringArray(inner) {
    const values = [];
    let index = 0;
    while (index < inner.length) {
        const ch = inner[index];
        if (ch === undefined) {
            break;
        }
        if (ch === " " || ch === "\t" || ch === "," || ch === "\n" || ch === "\r") {
            index += 1;
            continue;
        }
        if (ch !== "\"") {
            return undefined;
        }
        index += 1;
        let value = "";
        let closed = false;
        while (index < inner.length) {
            const next = inner[index];
            if (next === undefined) {
                return undefined;
            }
            if (next === "\\") {
                const escaped = inner[index + 1];
                if (escaped === undefined) {
                    return undefined;
                }
                value += escaped === "n" ? "\n" : escaped;
                index += 2;
                continue;
            }
            if (next === "\"") {
                index += 1;
                closed = true;
                values.push(value);
                break;
            }
            value += next;
            index += 1;
        }
        if (!closed) {
            return undefined;
        }
    }
    return values;
}
function unescapeToml(value) {
    return value.replaceAll(/\\(.)/g, (_match, char) => (char === "n" ? "\n" : char));
}
function isPoddrillTable(name) {
    const compact = name.replaceAll(" ", "").replaceAll("\t", "").replaceAll("\"", "").replaceAll("'", "");
    return compact === "mcp_servers.poddrill";
}
function scanTomlSections(text) {
    if (text.includes("\"\"\"") || text.includes("'''")) {
        return undefined;
    }
    const found = [];
    let mode = "top";
    let lineStart = 0;
    let index = 0;
    while (index < text.length) {
        const ch = text[index];
        if (ch === undefined) {
            break;
        }
        if (mode === "basic") {
            if (ch === "\\") {
                index += 2;
                continue;
            }
            if (ch === "\"") {
                mode = "top";
            }
            index += 1;
            continue;
        }
        if (mode === "literal") {
            if (ch === "'") {
                mode = "top";
            }
            index += 1;
            continue;
        }
        if (ch === "\n") {
            lineStart = index + 1;
            index += 1;
            continue;
        }
        if (ch === "#") {
            while (index < text.length && text[index] !== "\n") {
                index += 1;
            }
            continue;
        }
        if (ch === "\"") {
            mode = "basic";
            index += 1;
            continue;
        }
        if (ch === "'") {
            mode = "literal";
            index += 1;
            continue;
        }
        if (ch === "[" && onlySpace(text, lineStart, index)) {
            const header = readHeader(text, index);
            if (header === undefined) {
                return undefined;
            }
            const previous = found[found.length - 1];
            if (previous !== undefined) {
                found[found.length - 1] = {
                    ...previous,
                    bodyEnd: lineStart,
                    body: text.slice(previous.bodyEnd, lineStart),
                };
            }
            found.push({
                headerStart: lineStart,
                bodyEnd: header.end,
                name: header.name,
                body: "",
            });
            index = header.end;
            continue;
        }
        index += 1;
    }
    if (mode !== "top") {
        return undefined;
    }
    const last = found[found.length - 1];
    if (last !== undefined) {
        found[found.length - 1] = { ...last, bodyEnd: text.length, body: text.slice(last.bodyEnd) };
    }
    return found;
}
function onlySpace(text, from, to) {
    for (let index = from; index < to; index += 1) {
        const ch = text[index];
        if (ch !== " " && ch !== "\t" && ch !== "\r") {
            return false;
        }
    }
    return true;
}
function readHeader(text, index) {
    const newline = text.indexOf("\n", index);
    const lineEnd = newline === -1 ? text.length : newline;
    const line = text.slice(index, lineEnd).replace(/\r$/, "");
    const match = /^\[\[?\s*([^\]]+?)\s*\]\]?\s*(?:#.*)?$/.exec(line);
    const name = match?.[1];
    if (name === undefined || name.includes("[")) {
        return undefined;
    }
    return { name, end: lineEnd };
}
async function compareAndSwap(path, format, launcher) {
    await deleteLeftoverTemps(path);
    for (let attempt = 0; attempt < CONFIG_CAS_LIMIT; attempt += 1) {
        const current = await readOptionalUtf8(path);
        const merged = mergeText(current, format, launcher);
        if (typeof merged !== "string") {
            return {
                kind: "refused",
                reason: "unreadable-config",
                path,
                message: merged.detail,
            };
        }
        if (current !== undefined && current === merged) {
            return "unchanged";
        }
        const temp = `${path}.${serverName}-${randomBytes(6).toString("hex")}.tmp`;
        await mkdir(dirname(path), { recursive: true });
        await writeFile(temp, merged);
        const again = await readOptionalUtf8(path);
        if (again === current) {
            await rename(temp, path);
            return "written";
        }
        await rm(temp, { force: true });
    }
    return {
        kind: "refused",
        reason: "config-race",
        message: `${path} changed while it was being written`,
    };
}
function mergeText(current, format, launcher) {
    switch (format) {
        case "json":
            return mergeCursor(current, launcher);
        case "toml":
            return mergeGrok(current, launcher);
        default: {
            const leftover = format;
            throw new Error(`unexpected format ${String(leftover)}`);
        }
    }
}
function mergeCursor(current, launcher) {
    const entry = { command: launcher.command, args: [...launcher.args] };
    if (current === undefined || current.trim() === "") {
        return `${JSON.stringify({ mcpServers: { [serverName]: entry } }, null, 2)}\n`;
    }
    let parsed;
    try {
        parsed = JSON.parse(current);
    }
    catch {
        return { detail: "mcp.json is not valid JSON" };
    }
    const root = asRecord(parsed);
    if (root === undefined) {
        return { detail: "mcp.json must be a JSON object" };
    }
    const serversValue = root["mcpServers"];
    if (serversValue !== undefined && asRecord(serversValue) === undefined) {
        return { detail: "mcpServers is not an object" };
    }
    const servers = asRecord(serversValue) ?? {};
    const next = { ...root, mcpServers: { ...servers, [serverName]: entry } };
    return `${JSON.stringify(next, null, 2)}\n`;
}
function mergeGrok(current, launcher) {
    const table = desiredGrokTable(launcher);
    if (current === undefined || current.trim() === "") {
        return table;
    }
    const sections = scanTomlSections(current);
    if (sections === undefined) {
        return { detail: "config.toml headers cannot be scanned" };
    }
    const hits = sections.filter((section) => isPoddrillTable(section.name));
    if (hits.length > 1) {
        return { detail: "config.toml has more than one poddrill table" };
    }
    const hit = hits[0];
    if (hit === undefined) {
        const prefix = current.endsWith("\n") ? current : `${current}\n`;
        return `${prefix}\n${table}`;
    }
    return `${current.slice(0, hit.headerStart)}${table}${current.slice(hit.bodyEnd)}`;
}
function desiredGrokTable(launcher) {
    const args = launcher.args.map((arg) => `"${escapeToml(arg)}"`).join(", ");
    return [
        "[mcp_servers.poddrill]",
        `command = "${escapeToml(launcher.command)}"`,
        `args = [${args}]`,
        `startup_timeout_sec = ${GROK_STARTUP_TIMEOUT_SEC}`,
        "",
    ].join("\n");
}
function escapeToml(value) {
    return value.replaceAll("\\", "\\\\").replaceAll("\"", "\\\"");
}
async function deleteLeftoverTemps(path) {
    const dir = dirname(path);
    const prefix = `${basename(path)}.${serverName}-`;
    let names;
    try {
        names = await readdir(dir);
    }
    catch (error) {
        if (errorCode(error) === "ENOENT") {
            return;
        }
        throw error;
    }
    for (const name of names) {
        if (name.startsWith(prefix) && name.endsWith(".tmp")) {
            await rm(join(dir, name), { force: true });
        }
    }
}
async function staysInHome(home, candidate) {
    if (!pathStaysInHome(home, candidate)) {
        return false;
    }
    let homeReal;
    try {
        homeReal = await realpath(home);
    }
    catch (error) {
        if (errorCode(error) !== "ENOENT") {
            throw error;
        }
        await mkdir(home, { recursive: true });
        homeReal = await realpath(home);
    }
    return pathStaysInHome(homeReal, await resolveFromExisting(candidate));
}
async function resolveFromExisting(candidate) {
    const pending = [];
    let current = candidate;
    for (;;) {
        try {
            const found = await realpath(current);
            const rest = [...pending].reverse();
            return rest.length === 0 ? found : join(found, ...rest);
        }
        catch (error) {
            if (errorCode(error) !== "ENOENT") {
                throw error;
            }
            const parent = dirname(current);
            if (parent === current) {
                return normalize(candidate);
            }
            pending.push(basename(current));
            current = parent;
        }
    }
}
async function observeSkill(dest, bundle) {
    const parent = dirname(dest);
    const liveName = basename(dest);
    let names;
    try {
        names = await readdir(parent);
    }
    catch (error) {
        if (errorCode(error) === "ENOENT") {
            return { live: "absent", partialNext: [], completeNext: [], prev: [], orphanMarkers: [] };
        }
        throw error;
    }
    const bundleFiles = await filesIn(bundle);
    const partialNext = [];
    const completeNext = [];
    const prev = [];
    const orphanMarkers = [];
    const nameSet = new Set(names);
    for (const name of names) {
        const full = join(parent, name);
        if (name === liveName) {
            continue;
        }
        if (isMarkerName(name)) {
            const stem = name.slice(0, -skillMarkerSuffix.length);
            if (!nameSet.has(stem) || !(await isDirectory(join(parent, stem)))) {
                orphanMarkers.push(full);
            }
            continue;
        }
        if (name.startsWith(skillNextPrefix)) {
            const marked = await pathExists(markerPath(full));
            const directory = await isDirectory(full);
            const files = directory ? await filesIn(full) : undefined;
            if (directory && marked && bundleFiles !== undefined && files !== undefined && sameFiles(files, bundleFiles)) {
                completeNext.push(full);
            }
            else {
                partialNext.push(full);
            }
            continue;
        }
        if (name.startsWith(skillPrevPrefix)) {
            prev.push(full);
        }
    }
    let live = "absent";
    if (nameSet.has(liveName)) {
        const files = (await isDirectory(dest)) ? await filesIn(dest) : undefined;
        live =
            files !== undefined && bundleFiles !== undefined && sameFiles(files, bundleFiles) ? "match" : "differ";
    }
    partialNext.sort();
    completeNext.sort();
    prev.sort();
    orphanMarkers.sort();
    return { live, partialNext, completeNext, prev, orphanMarkers };
}
function isMarkerName(name) {
    return name.startsWith(skillNextPrefix) && name.endsWith(skillMarkerSuffix);
}
async function isDirectory(path) {
    try {
        const info = await statSafe(path);
        return info?.isDirectory() ?? false;
    }
    catch (error) {
        if (errorCode(error) === "ENOENT") {
            return false;
        }
        throw error;
    }
}
async function statSafe(path) {
    try {
        return await stat(path);
    }
    catch (error) {
        if (errorCode(error) === "ENOENT") {
            return undefined;
        }
        throw error;
    }
}
async function filesIn(dir) {
    const info = await statSafe(dir);
    if (info === undefined) {
        return undefined;
    }
    if (!info.isDirectory()) {
        return new Map([["", await readFile(dir)]]);
    }
    const out = new Map();
    await walkFiles(dir, dir, out);
    return out;
}
async function walkFiles(root, dir, out) {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) {
            await walkFiles(root, path, out);
            continue;
        }
        if (entry.isFile()) {
            out.set(relative(root, path), await readFile(path));
        }
    }
}
function sameFiles(left, right) {
    if (left.size !== right.size) {
        return false;
    }
    for (const [key, bytes] of left) {
        const other = right.get(key);
        if (other === undefined || !other.equals(bytes)) {
            return false;
        }
    }
    return true;
}
async function runSkillStep(dest, bundle, step) {
    switch (step.op) {
        case "done":
            return;
        case "drop":
            await rm(step.path, { recursive: true, force: true });
            if (!step.path.endsWith(skillMarkerSuffix)) {
                await rm(markerPath(step.path), { force: true });
            }
            return;
        case "stage": {
            const next = join(dirname(dest), `${skillNextPrefix}${randomBytes(8).toString("hex")}`);
            await cp(bundle, next, { recursive: true });
            await writeFile(markerPath(next), "");
            return;
        }
        case "promote":
            try {
                await rename(step.path, dest);
            }
            catch (error) {
                const code = errorCode(error);
                if (code === "EEXIST" || code === "ENOTEMPTY" || code === "ENOENT") {
                    return;
                }
                throw error;
            }
            return;
        case "aside": {
            const prev = join(dirname(dest), `${skillPrevPrefix}${randomBytes(8).toString("hex")}`);
            try {
                await rename(dest, prev);
            }
            catch (error) {
                if (errorCode(error) === "ENOENT") {
                    return;
                }
                throw error;
            }
            return;
        }
        default: {
            const leftover = step;
            throw new Error(`unexpected skill step ${JSON.stringify(leftover)}`);
        }
    }
}
