import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { clientMain } from "../src/client.ts";
import { NUMPY_PIN, ONNXRUNTIME_PIN } from "../src/python-env.ts";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

function expectedLauncher(home: string, options?: { readonly path?: string; readonly weights?: string }) {
  return {
    command: process.execPath,
    args: [join(repoRoot, "dist", "cli.js"), "mcp"],
    env: {
      PATH: options?.path ?? "",
      PODDRILL_PYTHON: "python3",
      PODDRILL_WORKSPACE: join(home, "poddrill"),
      PODDRILL_EMBED_WEIGHTS:
        options?.weights ?? join(home, ".cache", "poddrill", "ecapa", "voxceleb_ECAPA512.onnx"),
    },
  };
}

function grokSentence(home: string): string {
  const launcher = expectedLauncher(home);
  return [
    "Add a custom server named poddrill on this computer,",
    `command ${JSON.stringify(launcher.command)},`,
    `args ${JSON.stringify(launcher.args)},`,
    `env ${JSON.stringify(launcher.env)}.`,
  ].join(" ");
}
const moduleUrl = new URL("../src/cli.ts", import.meta.url).href;
const cliPath = fileURLToPath(new URL("../src/cli.ts", import.meta.url));

interface RunResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

describe("poddrill client", () => {
  it("plans a cursor install and writes nothing", async () => {
    const home = await tempHome();
    try {
      const before = await treeSnapshot(home);
      const rendered = await clientMain(["plan", "--client", "cursor", "--json"], { HOME: home }, moduleUrl);
      assert.equal(rendered.exitCode, 0);
      assert.deepEqual(parseLine(rendered.text), {
        kind: "plan",
        launcher: expectedLauncher(home),
        skill: { dest: join(home, ".agents", "skills", "poddrill"), action: "install" },
        effects: [
          {
            client: "cursor",
            path: join(home, ".cursor", "mcp.json"),
            record: { status: "absent" },
          },
        ],
      });
      assert.deepEqual(await treeSnapshot(home), before);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("apply --yes writes the pinned cursor entry and keeps another server", async () => {
    const home = await tempHome();
    try {
      const mcpPath = join(home, ".cursor", "mcp.json");
      await mkdir(join(home, ".cursor"), { recursive: true });
      await writeFile(
        mcpPath,
        `${JSON.stringify({ mcpServers: { other: { command: "echo", args: ["hi"] } } }, null, 2)}\n`,
      );
      const rendered = await clientMain(["apply", "--yes", "--client", "cursor"], { HOME: home }, moduleUrl);
      assert.equal(rendered.exitCode, 0);
      assert.deepEqual(parseLine(rendered.text), {
        kind: "applied",
        launcher: expectedLauncher(home),
        skill: "install",
        results: [{ client: "cursor", path: mcpPath, result: "written" }],
      });
      assert.deepEqual(JSON.parse(await readFile(mcpPath, "utf8")), {
        mcpServers: {
          other: { command: "echo", args: ["hi"] },
          poddrill: {
            command: process.execPath,
            args: [join(repoRoot, "dist", "cli.js"), "mcp"],
            env: expectedLauncher(home).env,
          },
        },
      });
      assert.equal(
        await readFile(join(home, ".agents", "skills", "poddrill", "SKILL.md"), "utf8"),
        await readFile(join(repoRoot, ".agents", "skills", "poddrill", "SKILL.md"), "utf8"),
      );
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("a second apply reports unchanged and does not rewrite a matching file", async () => {
    const home = await tempHome();
    try {
      const first = await clientMain(["apply", "--yes", "--client", "cursor"], { HOME: home }, moduleUrl);
      assert.equal(first.exitCode, 0);
      assert.equal(parseLine(first.text).results[0].result, "written");
      const mcpPath = join(home, ".cursor", "mcp.json");
      const before = await stat(mcpPath);
      const beforeBytes = await readFile(mcpPath);
      const second = await clientMain(["apply", "--yes", "--client", "cursor"], { HOME: home }, moduleUrl);
      const after = await stat(mcpPath);
      assert.equal(second.exitCode, 0);
      assert.deepEqual(parseLine(second.text), {
        kind: "applied",
        launcher: expectedLauncher(home),
        skill: "keep",
        results: [{ client: "cursor", path: mcpPath, result: "unchanged" }],
      });
      assert.equal(after.ino, before.ino);
      assert.equal(after.mtimeNs, before.mtimeNs);
      assert.deepEqual(await readFile(mcpPath), beforeBytes);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("refuses malformed mcp.json without copying the skill", async () => {
    const home = await tempHome();
    try {
      const mcpPath = join(home, ".cursor", "mcp.json");
      await mkdir(join(home, ".cursor"), { recursive: true });
      await writeFile(mcpPath, "{");
      const rendered = await clientMain(["apply", "--yes", "--client", "cursor"], { HOME: home }, moduleUrl);
      assert.equal(rendered.exitCode, 1);
      const body = parseLine(rendered.text);
      assert.equal(body.kind, "refused");
      assert.equal(body.reason, "unreadable-config");
      assert.equal(body.path, mcpPath);
      assert.equal(await readFile(mcpPath, "utf8"), "{");
      await assert.rejects(stat(join(home, ".agents", "skills", "poddrill")));
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("grok_bot apply copies the skill and writes no config file", async () => {
    const home = await tempHome();
    try {
      const rendered = await clientMain(["apply", "--yes", "--client", "grok_bot"], { HOME: home }, moduleUrl);
      assert.equal(rendered.exitCode, 0);
      assert.deepEqual(parseLine(rendered.text), {
        kind: "applied",
        launcher: expectedLauncher(home),
        skill: "install",
        results: [
          {
            client: "grok_bot",
            sentence: grokSentence(home),
          },
        ],
      });
      assert.equal(
        await readFile(join(home, ".agents", "skills", "poddrill", "SKILL.md"), "utf8"),
        await readFile(join(repoRoot, ".agents", "skills", "poddrill", "SKILL.md"), "utf8"),
      );
      await assert.rejects(stat(join(home, ".cursor", "mcp.json")));
      await assert.rejects(stat(join(home, ".grok", "config.toml")));
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("setup --client writes no workspace", async () => {
    const root = await tempHome();
    try {
      const result = await run(root, [
        "setup",
        "--provider",
        "localhost",
        "--queue-length",
        "2",
        "--client",
        "cursor",
      ]);
      assert.equal(result.code, 1);
      assert.equal(result.stderr, "");
      assert.deepEqual(parseLine(result.stdout), {
        kind: "error",
        message: [
          "poddrill setup writes a workspace. Register a client with: usage: poddrill",
          "client doctor --client <cursor|grok_build|grok_bot> [--json]",
          "| client plan --client <cursor|grok_build|grok_bot> [--json]",
          "| client plan --linked [--json]",
          "| client apply --yes --client <cursor|grok_build|grok_bot> [--json]",
          "| client apply --yes --linked [--json]",
        ].join(" "),
      });
      await assert.rejects(stat(join(root, "poddrill.json")));
      assert.deepEqual(await readdir(root), []);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("doctor reports probes and does not spawn an installer", async () => {
    const home = await tempHome();
    const bin = await tempHome();
    try {
      const logPath = join(home, "spawns.log");
      const weights = join(home, "missing-ecapa.onnx");
      await writeShim(bin, logPath, await cactusNeedle());
      const rendered = await clientMain(["doctor", "--client", "cursor", "--json"], {
        HOME: home,
        PATH: bin,
        PODDRILL_SPAWN_LOG: logPath,
        PODDRILL_EMBED_WEIGHTS: weights,
      }, moduleUrl);
      const needle = await cactusNeedle();
      assert.equal(rendered.exitCode, 1);
      assert.deepEqual(parseLine(rendered.text), {
        kind: "doctor",
        client: "cursor",
        launcher: expectedLauncher(home, { path: bin, weights }),
        checks: [
          { name: "skill-bundle", state: "ok" },
          { name: "node", state: "ok", version: process.version },
          { name: "ffmpeg", state: "ok" },
          { name: "cactus-needle", state: "ok", version: needle },
          { name: "numpy", state: "ok", version: NUMPY_PIN },
          { name: "onnxruntime", state: "ok", version: ONNXRUNTIME_PIN },
          {
            name: "ecapa",
            state: "bad",
            path: weights,
            detail: "ECAPA weights are missing",
            fix: "poddrill fetch-weights",
          },
          {
            name: "workspace",
            state: "pending",
            path: join(home, "poddrill"),
            detail: "No poddrill workspace yet.",
            fix: "poddrill setup --provider localhost --queue-length 4",
          },
          {
            name: "yt-dlp",
            state: "optional",
            detail: "Not required for setup.",
            fix: "python3 -m pip install --upgrade yt-dlp",
          },
          {
            name: "link",
            client: "cursor",
            record: { status: "absent" },
            fix: "poddrill client plan --client cursor --json && poddrill client apply --yes --client cursor",
          },
        ],
      });
      assert.equal(await readFile(logPath, "utf8"), "ffmpeg\npython3\npython3\npython3\npython3\n");
      await assert.rejects(stat(weights));
      await assert.rejects(stat(join(home, ".agents", "skills", "poddrill")));
      await assert.rejects(stat(join(home, ".cursor", "mcp.json")));
    } finally {
      await rm(home, { recursive: true, force: true });
      await rm(bin, { recursive: true, force: true });
    }
  });

  it("a differing grok table keeps the previous timeout and the other table", async () => {
    const home = await tempHome();
    try {
      const configPath = join(home, ".grok", "config.toml");
      await mkdir(join(home, ".grok"), { recursive: true });
      const original = [
        "[mcp_servers.poddrill]",
        "command = \"poddrill\"",
        "args = [\"mcp\"]",
        "startup_timeout_sec = 5",
        "",
        "[other]",
        "name = \"kept\"",
        "",
      ].join("\n");
      await writeFile(configPath, original);
      const planned = await clientMain(["plan", "--client", "grok_build"], { HOME: home }, moduleUrl);
      assert.equal(planned.exitCode, 0);
      assert.equal(await readFile(configPath, "utf8"), original);
      assert.deepEqual(parseLine(planned.text).effects[0].record, {
        status: "differ",
        previous: { command: "poddrill", args: ["mcp"], startupTimeoutSec: 5 },
      });
      const applied = await clientMain(["apply", "--yes", "--client", "grok_build"], { HOME: home }, moduleUrl);
      assert.equal(applied.exitCode, 0);
      assert.equal(parseLine(applied.text).results[0].result, "written");
      const updated = await readFile(configPath, "utf8");
      assert.equal(updated.includes("[other]"), true);
      assert.equal(updated.includes("name = \"kept\""), true);
      assert.equal(updated.includes("startup_timeout_sec = 30"), true);
      assert.equal(updated.includes("dist/cli.js"), true);
      assert.equal(updated.includes("PODDRILL_PYTHON"), true);
      assert.equal(updated.includes("startup_timeout_sec = 5"), false);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});

function parseLine(text: string): Record<string, unknown> {
  assert.equal(text.endsWith("\n"), true);
  assert.equal(text.slice(0, -1).includes("\n"), false);
  const parsed: unknown = JSON.parse(text);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("client stdout is not a JSON object");
  }
  const record: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(parsed)) {
    record[key] = value;
  }
  return record;
}

async function cactusNeedle(): Promise<string> {
  const parsed: unknown = JSON.parse(await readFile(join(repoRoot, "package.json"), "utf8"));
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("package.json is not an object");
  }
  const version = Object.entries(parsed).find(([key]) => key === "cactusNeedle")?.[1];
  if (typeof version !== "string") {
    throw new Error("package.json has no cactusNeedle");
  }
  return version;
}

async function tempHome(): Promise<string> {
  return mkdtemp(join(tmpdir(), "poddrill-client-"));
}

async function treeSnapshot(dir: string): Promise<readonly string[]> {
  const found: string[] = [];
  await walk(dir, dir, found);
  found.sort();
  return found;
}

async function walk(root: string, dir: string, found: string[]): Promise<void> {
  let names: readonly string[];
  try {
    names = await readdir(dir);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return;
    }
    throw error;
  }
  for (const name of names) {
    const path = join(dir, name);
    const info = await stat(path);
    const rel = path.slice(root.length);
    if (info.isDirectory()) {
      found.push(`${rel}/`);
      await walk(root, path, found);
      continue;
    }
    found.push(rel);
  }
}

async function writeShim(bin: string, logPath: string, needleVersion: string): Promise<void> {
  const script = [
    "#!/bin/sh",
    "name=${0##*/}",
    `printf '%s\\n' "$name" >> '${logPath}'`,
    "if [ \"$name\" = \"ffmpeg\" ]; then",
    "  exit 0",
    "fi",
    "if [ \"$name\" = \"python3\" ]; then",
    "  case \"$*\" in",
    "    *\"import needle\"*)",
    `      printf '%s\\n' '${needleVersion}'`,
    "      exit 0",
    "      ;;",
    "    *\"import numpy\"*)",
    `      printf '%s\\n' '${NUMPY_PIN}'`,
    "      exit 0",
    "      ;;",
    "    *\"import onnxruntime\"*)",
    `      printf '%s\\n' '${ONNXRUNTIME_PIN}'`,
    "      exit 0",
    "      ;;",
    "    *yt_dlp*)",
    "      exit 1",
    "      ;;",
    "  esac",
    "  exit 99",
    "fi",
    "exit 99",
    "",
  ].join("\n");
  for (const name of ["ffmpeg", "python3", "npm", "npx", "pip", "pip3", "brew", "curl"]) {
    await writeFile(join(bin, name), script, { mode: 0o755 });
  }
}

function run(root: string, args: readonly string[]): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--experimental-strip-types", cliPath, ...args], {
      cwd: repoRoot,
      env: { ...process.env, PODDRILL_WORKSPACE: root, NODE_NO_WARNINGS: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => {
      out.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      err.push(chunk);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      resolve({
        code: code ?? 1,
        stdout: Buffer.concat(out).toString("utf8"),
        stderr: Buffer.concat(err).toString("utf8"),
      });
    });
  });
}
