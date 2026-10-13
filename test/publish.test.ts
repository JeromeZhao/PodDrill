import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
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
