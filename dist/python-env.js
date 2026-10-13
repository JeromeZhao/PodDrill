/**
 * The interpreter PodDrill spawns, and the venv that holds its pinned imports.
 * `PODDRILL_PYTHON` wins, then `poddrill.json`, then `~/.cache/poddrill/venv`, then `python3`.
 */
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { errorCode, pathExists } from "./disk.js";
import { readPackageIdentity } from "./package-identity.js";
export const NUMPY_PIN = "2.5.4";
export const ONNXRUNTIME_PIN = "1.31.0";
export const INSTALL_PYTHON_FIX = "poddrill install-python";
/** `HOME` from the env when it is absolute, otherwise the process home. */
export function homeFromEnv(env) {
    const home = env["HOME"];
    if (home !== undefined && home !== "" && isAbsolute(home)) {
        return home;
    }
    return homedir();
}
export function defaultVenvDir(env) {
    return join(homeFromEnv(env), ".cache", "poddrill", "venv");
}
export function defaultVenvPython(env) {
    return join(defaultVenvDir(env), "bin", "python");
}
/** Sync lookup for workers. The owner has already resolved a venv into `PODDRILL_PYTHON`. */
export function pythonFromEnv(env) {
    const configured = env["PODDRILL_PYTHON"];
    if (configured !== undefined && configured !== "") {
        return configured;
    }
    return "python3";
}
export async function resolvePython(env, configured) {
    const fromEnv = env["PODDRILL_PYTHON"];
    if (fromEnv !== undefined && fromEnv !== "") {
        return fromEnv;
    }
    if (configured !== undefined && configured !== "") {
        return configured;
    }
    const venvPython = defaultVenvPython(env);
    if (await pathExists(venvPython)) {
        return venvPython;
    }
    return "python3";
}
export async function pythonPins(moduleUrl) {
    const identity = await readPackageIdentity(moduleUrl);
    return {
        "cactus-needle": identity.cactusNeedle,
        numpy: NUMPY_PIN,
        onnxruntime: ONNXRUNTIME_PIN,
    };
}
export function ytDlpFix(python) {
    return `${shellWord(python)} -m pip install --upgrade yt-dlp`;
}
export function moonshineInstallLine() {
    return 'Install moonshine-voice into the PodDrill Python: "$PODDRILL_PYTHON" -m pip install moonshine-voice';
}
/**
 * Create `~/.cache/poddrill/venv` when the pins are missing and install them there.
 * Uses `uv` when it is on PATH. Otherwise `python3 -m venv`. A second call with the pins present does nothing.
 */
export async function installPython(env, moduleUrl) {
    const pins = await pythonPins(moduleUrl);
    const python = defaultVenvPython(env);
    if (await pinsMatch(python, pins, env)) {
        return { python, created: false, installer: "cached", pins };
    }
    const spawnEnv = commandEnv(env);
    const uv = await commandWorks("uv", ["--version"], spawnEnv);
    if (uv) {
        await installWithUv(python, defaultVenvDir(env), pins, spawnEnv);
        await assertPins(python, pins, env);
        return { python, created: true, installer: "uv", pins };
    }
    await installWithVenv(python, defaultVenvDir(env), pins, env, spawnEnv);
    await assertPins(python, pins, env);
    return { python, created: true, installer: "venv", pins };
}
export function chooseInstaller(uvAvailable) {
    return uvAvailable ? "uv" : "venv";
}
async function installWithUv(python, dest, pins, spawnEnv) {
    if (!(await pathExists(python))) {
        const created = await runProcess("uv", ["venv", dest], spawnEnv);
        if (created.code !== 0) {
            throw new Error(`uv venv failed: ${tail(created.stderr)}`);
        }
    }
    const installed = await runProcess("uv", ["pip", "install", "--python", python, ...pinArgs(pins)], spawnEnv);
    if (installed.code !== 0) {
        throw new Error(`uv pip install failed: ${tail(`${installed.stdout}\n${installed.stderr}`)}`);
    }
}
async function installWithVenv(python, dest, pins, env, spawnEnv) {
    if (!(await pathExists(python))) {
        const base = venvBase(env, dest);
        const created = await runProcess(base, ["-m", "venv", dest], spawnEnv);
        if (created.code !== 0) {
            throw new Error([
                `python -m venv failed: ${tail(`${created.stdout}\n${created.stderr}`)}`,
                "Install the python3-venv package, or install uv and run poddrill install-python again.",
            ].join(" "));
        }
    }
    const installed = await runProcess(python, ["-m", "pip", "install", "--disable-pip-version-check", ...pinArgs(pins)], spawnEnv);
    if (installed.code !== 0) {
        throw new Error(`pip install failed: ${tail(`${installed.stdout}\n${installed.stderr}`)}`);
    }
}
function venvBase(env, dest) {
    const configured = pythonFromEnv(env);
    if (configured === "python3" || configured.startsWith(`${dest}/`)) {
        return "python3";
    }
    return configured;
}
function pinArgs(pins) {
    return [
        `cactus-needle==${pins["cactus-needle"]}`,
        `numpy==${pins.numpy}`,
        `onnxruntime==${pins.onnxruntime}`,
    ];
}
async function assertPins(python, pins, env) {
    if (!(await pinsMatch(python, pins, env))) {
        throw new Error(`PodDrill Python at ${python} does not import the pinned packages`);
    }
}
async function pinsMatch(python, pins, env) {
    if (!(await pathExists(python))) {
        return false;
    }
    const result = await runProcess(python, ["-c", PIN_PROBE], commandEnv(env));
    if (result.code !== 0) {
        return false;
    }
    const found = new Map();
    for (const line of result.stdout.split("\n")) {
        const index = line.indexOf("==");
        if (index <= 0) {
            continue;
        }
        found.set(line.slice(0, index), line.slice(index + 2).trim());
    }
    return (found.get("cactus-needle") === pins["cactus-needle"] &&
        found.get("numpy") === pins.numpy &&
        found.get("onnxruntime") === pins.onnxruntime);
}
const PIN_PROBE = [
    "import importlib.metadata as meta",
    "for name in ('cactus-needle', 'numpy', 'onnxruntime'):",
    "    print(name + '==' + meta.version(name))",
].join("\n");
function commandEnv(env) {
    const copy = {};
    for (const [key, value] of Object.entries(env)) {
        if (value !== undefined) {
            copy[key] = value;
        }
    }
    if (copy["PATH"] === undefined && process.env["PATH"] !== undefined) {
        copy["PATH"] = process.env["PATH"];
    }
    return copy;
}
async function commandWorks(command, args, env) {
    const result = await runProcess(command, args, env);
    return result.code === 0;
}
function runProcess(command, args, env) {
    return new Promise((resolve, reject) => {
        const child = spawn(command, [...args], { env, stdio: ["ignore", "pipe", "pipe"] });
        const out = [];
        const err = [];
        let settled = false;
        const finish = (result) => {
            if (settled) {
                return;
            }
            settled = true;
            resolve(result);
        };
        child.stdout.on("data", (chunk) => {
            out.push(chunk);
        });
        child.stderr.on("data", (chunk) => {
            err.push(chunk);
        });
        child.on("error", (error) => {
            if (errorCode(error) === "ENOENT") {
                finish({ code: null, stdout: "", stderr: error.message });
                return;
            }
            reject(error);
        });
        child.on("close", (code) => {
            finish({
                code,
                stdout: Buffer.concat(out).toString("utf8"),
                stderr: Buffer.concat(err).toString("utf8"),
            });
        });
    });
}
function tail(text) {
    const trimmed = text.trim();
    if (trimmed.length <= 1500) {
        return trimmed === "" ? "no output" : trimmed;
    }
    return trimmed.slice(-1500);
}
function shellWord(value) {
    if (/^[A-Za-z0-9_./:-]+$/.test(value)) {
        return value;
    }
    return `"${value.replaceAll("\"", "\\\"")}"`;
}
