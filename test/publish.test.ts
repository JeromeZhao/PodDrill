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

test("a summary follows speaker labels and the stored summary commands", async () => {
  const skill = await readFile(join(root, ".agents", "skills", "poddrill", "SKILL.md"), "utf8");
  const summary = await readFile(
    join(root, ".agents", "skills", "poddrill", "references", "create-summary.md"),
    "utf8",
  );
  assert.equal(skill.includes("A summary does not require those labels."), false);
  assert.equal(skill.includes("Do not write a summary from the transcript text alone."), true);
  const labelAt = skill.indexOf("poddrill label-groups");
  const summaryAt = skill.indexOf("poddrill start-summary");
  assert.equal(labelAt >= 0, true);
  assert.equal(summaryAt > labelAt, true);
  assert.equal(skill.includes("poddrill post-paragraph"), true);
  assert.equal(skill.includes("poddrill set-summary"), true);
  assert.equal(skill.includes("poddrill summary"), true);
  assert.equal(summary.includes("Do not write a summary from the transcript text."), true);
});

test("setup instructions leave optional tools until a task needs them", async () => {
  const skill = await readFile(join(root, ".agents", "skills", "poddrill", "SKILL.md"), "utf8");
  const fetchAudio = await readFile(
    join(root, ".agents", "skills", "poddrill", "references", "fetch-audio.md"),
    "utf8",
  );
  const models = await readFile(
    join(root, ".agents", "skills", "poddrill", "references", "select-models.md"),
    "utf8",
  );
  assert.equal(skill.includes("yt-dlp"), false);
  assert.equal(skill.includes("moonshine-voice"), false);
  assert.equal(skill.includes("Ask the user before you install anything that guide names."), true);
  assert.equal(fetchAudio.includes("Ask the user before you install yt-dlp."), true);
  assert.equal(models.includes("Ask the user before you install moonshine-voice."), true);
});
