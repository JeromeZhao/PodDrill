import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

test("the published command is JavaScript", async () => {
  const child = spawn(process.execPath, [join(root, "dist", "cli.js")], {
    cwd: root,
  });
  let stdout = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
  });
  const [code] = await once(child, "exit");
  assert.equal(code, 1);
  assert.equal(stdout.includes("usage: poddrill"), true);
});

test("install lines name the package.json version", async () => {
  const parsed: unknown = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  assert.equal(typeof parsed, "object");
  assert.equal(parsed === null, false);
  if (typeof parsed !== "object" || parsed === null) {
    return;
  }
  const version = Object.fromEntries(Object.entries(parsed))["version"];
  assert.equal(typeof version, "string");
  if (typeof version !== "string") {
    return;
  }
  const spec = `poddrill@${version}`;
  const readme = await readFile(join(root, "README.md"), "utf8");
  const skill = await readFile(join(root, ".agents", "skills", "poddrill", "SKILL.md"), "utf8");
  assert.equal(readme.includes(spec), true);
  assert.equal(skill.includes(spec), true);
  assert.equal(readme.includes("poddrill@<version>"), false);
  assert.equal(skill.includes("poddrill@<version>"), false);
});

function runBump(
  cwd: string,
  bump: string,
): Promise<{ readonly code: number; readonly stdout: string; readonly stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(root, "scripts", "bump-version.mjs"), bump], { cwd });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      resolve({ code: code ?? 1, stdout, stderr });
    });
  });
}

async function versionFixture(version: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "poddrill-bump-"));
  await mkdir(join(dir, ".agents", "skills", "poddrill"), { recursive: true });
  await writeFile(
    join(dir, "package.json"),
    `${JSON.stringify({ name: "poddrill", version }, null, 2)}\n`,
  );
  await writeFile(join(dir, "README.md"), `Run npm install -g poddrill@${version}.\n`);
  await writeFile(
    join(dir, ".agents", "skills", "poddrill", "SKILL.md"),
    `Run npm install -g poddrill@${version}.\n`,
  );
  return dir;
}

test("a semver bump rewrites only the version files", async () => {
  const dir = await versionFixture("1.2.3");
  try {
    const patch = await runBump(dir, "patch");
    assert.equal(patch.stderr, "");
    assert.equal(patch.code, 0);
    assert.equal(patch.stdout, "1.2.4\n");
    assert.equal(await readFile(join(dir, "README.md"), "utf8"), "Run npm install -g poddrill@1.2.4.\n");
    assert.equal(
      await readFile(join(dir, ".agents", "skills", "poddrill", "SKILL.md"), "utf8"),
      "Run npm install -g poddrill@1.2.4.\n",
    );
    const parsed: unknown = JSON.parse(await readFile(join(dir, "package.json"), "utf8"));
    assert.equal(typeof parsed, "object");
    assert.equal(parsed === null, false);
    if (typeof parsed !== "object" || parsed === null) {
      return;
    }
    assert.equal(Object.fromEntries(Object.entries(parsed))["version"], "1.2.4");
    assert.equal(Object.fromEntries(Object.entries(parsed))["name"], "poddrill");

    const minor = await runBump(dir, "minor");
    assert.equal(minor.code, 0, minor.stderr);
    assert.equal(minor.stdout, "1.3.0\n");
    const major = await runBump(dir, "major");
    assert.equal(major.code, 0, major.stderr);
    assert.equal(major.stdout, "2.0.0\n");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
