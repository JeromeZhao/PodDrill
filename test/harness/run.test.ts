import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { runFromArgv, runHarness, type HarnessReport } from "./run.ts";
import { episodeIdFromDigest } from "../../src/workspace.ts";

const workspacePath = join(tmpdir(), "poddrill-harness-workspace");
const fixturePath = join(tmpdir(), "poddrill-harness-fixture.wav");
const leasePath = join(tmpdir(), "poddrill-harness-lease.json");
const episodeId = "ep_e700dfd0455f7fc6";
const cactusMessage = "mac provider requires cactus-needle, which is not installed in this process";

const fakeGbot = [
  `#!${process.execPath}`,
  "const { readFileSync, writeFileSync, mkdirSync, copyFileSync } = require(\"node:fs\");",
  "const { createHash } = require(\"node:crypto\");",
  "const { join } = require(\"node:path\");",
  "const { tmpdir } = require(\"node:os\");",
  "const statePath = process.env.PWH_FAKE_STATE;",
  "if (typeof statePath !== \"string\" || statePath === \"\") {",
  "  process.exit(1);",
  "}",
  "const state = JSON.parse(readFileSync(statePath, \"utf8\"));",
  "const argv = process.argv.slice(2);",
  "state.log.push(argv);",
  "const cactus = \"mac provider requires cactus-needle, which is not installed in this process\";",
  "const needle = \"ModuleNotFoundError: No module named 'needle'\";",
  "function save(code, body) {",
  "  writeFileSync(statePath, JSON.stringify(state));",
  "  if (body !== undefined) process.stdout.write(JSON.stringify(body));",
  "  process.exit(code);",
  "}",
  "function flag(name) {",
  "  const index = argv.indexOf(name);",
  "  return index === -1 ? undefined : argv[index + 1];",
  "}",
  "function writeEpisode(kind) {",
  "  const workspace = join(tmpdir(), \"poddrill-harness-workspace\");",
  "  const fixture = join(tmpdir(), \"poddrill-harness-fixture.wav\");",
  "  const bytes = readFileSync(fixture);",
  "  const sha = createHash(\"sha256\").update(bytes).digest(\"hex\");",
  "  const id = \"ep_\" + sha.slice(0, 16);",
  "  const dir = join(workspace, \"episodes\", id);",
  "  mkdirSync(join(dir, \"transcript\"), { recursive: true });",
  "  mkdirSync(join(dir, \"embedding\"), { recursive: true });",
  "  copyFileSync(fixture, join(dir, \"source.wav\"));",
  "  writeFileSync(join(workspace, \"poddrill.json\"), JSON.stringify({ provider: \"localhost\", queueLength: 1 }));",
  "  writeFileSync(join(dir, \"episode.json\"), JSON.stringify({",
  "    episodeId: id,",
  "    sha256: sha,",
  "    sourceName: \"episode.wav\",",
  "    sourceFile: \"source.wav\",",
  "    durationMs: 1,",
  "    enqueuedAt: \"2026-01-01T00:00:00.000Z\",",
  "    language: \"en\",",
  "  }));",
  "  state.episodeDir = dir;",
  "  if (kind === \"cactus\" || kind === \"needle\" || kind === \"live-needle\") {",
  "    const message = kind === \"needle\" ? needle : cactus;",
  "    writeFileSync(join(dir, \"transcript\", \"failed.json\"), JSON.stringify({ message: message }));",
  "    return;",
  "  }",
  "  writeFileSync(join(dir, \"transcript\", \"transcript.vtt\"), \"WEBVTT\\n\");",
  "  writeFileSync(join(dir, \"embedding\", \"embedding.json\"), \"{}\\n\");",
  "}",
  "const cmd = argv[0];",
  "const sub = argv[1];",
  "if (cmd === \"bots\" && sub === \"list\") {",
  "  state.lists.push(state.roster.slice());",
  "  save(0, state.roster);",
  "}",
  "if (cmd === \"bots\" && sub === \"create\") {",
  "  const name = flag(\"--name\");",
  "  if (state.mode === \"create-nonzero\" || typeof name !== \"string\" || name === \"\") {",
  "    save(1, { error: \"create failed\" });",
  "  }",
  "  if (state.mode === \"ambiguous\") {",
  "    state.roster = state.roster.concat([name, \"extra-bot\"]);",
  "  } else {",
  "    state.roster = state.roster.concat([name]);",
  "  }",
  "  save(0, { name: name });",
  "}",
  "if (cmd === \"bots\" && sub === \"delete\") {",
  "  const name = argv[2];",
  "  state.deleted.push(name);",
  "  state.roster = state.roster.filter((item) => item !== name);",
  "  save(0, { ok: true });",
  "}",
  "if (cmd === \"skills\" && sub === \"list\") save(0, state.skills);",
  "if (cmd === \"skills\" && sub === \"add\") {",
  "  state.skills.push(argv[2]);",
  "  save(0, { ok: true });",
  "}",
  "if (cmd === \"send\") {",
  "  if (state.mode === \"default\") writeEpisode(\"cactus\");",
  "  if (state.mode === \"needle\") writeEpisode(\"needle\");",
  "  if (state.mode === \"live-needle\") writeEpisode(\"live-needle\");",
  "  if (state.mode === \"live\") writeEpisode(\"ready\");",
  "  save(0, { ok: true });",
  "}",
  "if (cmd === \"thread\") {",
  "  state.threads += 1;",
  "  if (state.mode === \"live\" && state.threads === 1) {",
  "    writeFileSync(",
  "      join(state.episodeDir, \"labels.json\"),",
  "      JSON.stringify([{ groupId: \"g1\", label: \"Chamath\" }]),",
  "    );",
  "  }",
  "  if (state.mode === \"live\" && state.threads === 2) {",
  "    const summary = [",
  "      \"version: 1\",",
  "      \"episodeId: \" + state.episodeDir.split(\"/\").pop(),",
  "      \"summaryId: sm_0123456789abcdef\",",
  "      \"summary: Chamath says the round was about rates.\",",
  "      \"paragraphs:\",",
  "      \"  - index: 0\",",
  "      \"    text: Chamath says the round was about rates.\",",
  "      \"    from: \\\"00:00:00.000\\\"\",",
  "      \"    through: \\\"00:00:01.000\\\"\",",
  "      \"    startMs: 0\",",
  "      \"    endMs: 1000\",",
  "    ].join(\"\\n\");",
  "    mkdirSync(join(state.episodeDir, \"summaries\"), { recursive: true });",
  "    writeFileSync(join(state.episodeDir, \"summaries\", \"sm_0123456789abcdef.yaml\"), summary);",
  "  }",
  "  save(0, { cursor: \"c1\", entryCount: state.threads, gapReset: false });",
  "}",
  "save(1, { error: \"unknown command\" });",
  "",
].join("\n");

interface FakeState {
  readonly mode: string;
  readonly roster: readonly string[];
  readonly skills: readonly string[];
  readonly log: readonly (readonly string[])[];
  readonly lists: readonly (readonly string[])[];
  readonly deleted: readonly string[];
  readonly threads: number;
  readonly episodeDir: string;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringMatrix(value: unknown): readonly (readonly string[])[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const rows: (readonly string[])[] = [];
  for (const row of value) {
    if (!Array.isArray(row) || row.some((item) => typeof item !== "string")) {
      return undefined;
    }
    rows.push(row);
  }
  return rows;
}

function stringList(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    return undefined;
  }
  return value;
}

function parseState(value: unknown): FakeState {
  if (!isRecord(value)) {
    throw new Error("fake gbot state is not an object");
  }
  const roster = stringList(value["roster"]);
  const skills = stringList(value["skills"]);
  const log = stringMatrix(value["log"]);
  const lists = stringMatrix(value["lists"]);
  const deleted = stringList(value["deleted"]);
  if (
    typeof value["mode"] !== "string" ||
    roster === undefined ||
    skills === undefined ||
    log === undefined ||
    lists === undefined ||
    deleted === undefined ||
    typeof value["threads"] !== "number" ||
    typeof value["episodeDir"] !== "string"
  ) {
    throw new Error("fake gbot state is missing a field");
  }
  return {
    mode: value["mode"],
    roster,
    skills,
    log,
    lists,
    deleted,
    threads: value["threads"],
    episodeDir: value["episodeDir"],
  };
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: unknown) {
    return isRecord(error) && error["code"] === "EPERM";
  }
}

async function clearOwnLease(): Promise<void> {
  let text: string;
  try {
    text = await readFile(leasePath, "utf8");
  } catch {
    return;
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    await rm(leasePath, { force: true });
    return;
  }
  const pid = isRecord(value) ? value["pid"] : undefined;
  if (typeof pid === "number" && pid !== process.pid && pidAlive(pid)) {
    return;
  }
  await rm(leasePath, { force: true });
}

async function withFake(
  mode: string,
  roster: readonly string[],
  body: (gbotPath: string) => Promise<void>,
): Promise<FakeState> {
  const dir = await mkdtemp(join(tmpdir(), "pwh-fake-"));
  const gbotPath = join(dir, "gbot.cjs");
  const statePath = join(dir, "state.json");
  const savedPath = process.env["PATH"];
  const savedState = process.env["PWH_FAKE_STATE"];
  await writeFile(gbotPath, fakeGbot);
  await chmod(gbotPath, 0o755);
  await writeFile(
    statePath,
    JSON.stringify({
      mode,
      roster: [...roster],
      skills: [],
      log: [],
      lists: [],
      deleted: [],
      threads: 0,
      episodeDir: "",
    }),
  );
  process.env["PATH"] = dir;
  process.env["PWH_FAKE_STATE"] = statePath;
  try {
    await clearOwnLease();
    await body(gbotPath);
    const parsed: unknown = JSON.parse(await readFile(statePath, "utf8"));
    return parseState(parsed);
  } finally {
    if (savedPath === undefined) {
      delete process.env["PATH"];
    } else {
      process.env["PATH"] = savedPath;
    }
    if (savedState === undefined) {
      delete process.env["PWH_FAKE_STATE"];
    } else {
      process.env["PWH_FAKE_STATE"] = savedState;
    }
    await rm(dir, { recursive: true, force: true });
  }
}

async function captureArgv(argv: readonly string[]): Promise<{ readonly code: number; readonly stdout: string }> {
  const chunks: string[] = [];
  const original = process.stdout.write;
  process.stdout.write = ((chunk: string | Uint8Array): boolean => {
    chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    return true;
  }) as typeof process.stdout.write;
  try {
    const code = await runFromArgv(argv);
    return { code, stdout: chunks.join("") };
  } finally {
    process.stdout.write = original;
  }
}

function mintedName(state: FakeState): string {
  const created = state.lists[1];
  const name = created === undefined ? undefined : created[0];
  if (name === undefined || !/^pwh-[0-9a-f]{8}$/.test(name)) {
    throw new Error("roster did not gain one pwh- name");
  }
  return name;
}

after(async () => {
  await rm(workspacePath, { recursive: true, force: true });
  await rm(fixturePath, { force: true });
  await rm(leasePath, { force: true });
});

test("rejects an unknown argument before calling gbot", async () => {
  const state = await withFake("default", [], async () => {
    const result = await captureArgv(["--live", "--bogus"]);
    assert.deepEqual(result, { code: 2, stdout: "" });
  });
  assert.deepEqual(state.log, []);
});

test("ambiguous roster deletes nothing", async () => {
  const state = await withFake("ambiguous", ["kept"], async (gbotPath) => {
    const report = await runHarness({ gbotPath });
    assert.deepEqual(report, {
      kind: "fail",
      code: "roster-ambiguous",
      workspacePath,
    });
  });
  const name = state.roster[1];
  assert.deepEqual(state.deleted, []);
  assert.deepEqual(state.roster, ["kept", name, "extra-bot"]);
  assert.equal(
    state.log.some((argv) => argv[0] === "bots" && argv[1] === "delete"),
    false,
  );
  assert.deepEqual(
    state.log.find((argv) => argv[0] === "bots" && argv[1] === "create"),
    ["bots", "create", "--name", name, "--json"],
  );
});

test("a non-zero create deletes nothing", async () => {
  const state = await withFake("create-nonzero", ["kept"], async (gbotPath) => {
    const report = await runHarness({ gbotPath });
    assert.deepEqual(report, {
      kind: "fail",
      code: "roster-ambiguous",
      workspacePath,
    });
  });
  assert.deepEqual(state.roster, ["kept"]);
  assert.deepEqual(state.deleted, []);
  assert.equal(
    state.log.some((argv) => argv[0] === "bots" && argv[1] === "delete"),
    false,
  );
});

test("default pass on the cactus-needle failed.json", async () => {
  const state = await withFake("default", [], async (gbotPath) => {
    const result = await captureArgv(["--gbot", gbotPath]);
    const report: unknown = JSON.parse(result.stdout);
    assert.equal(result.code, 0);
    assert.deepEqual(report, {
      kind: "pass-default",
      transcript: "blocked-on-cactus-needle",
      episodeId,
      workspacePath,
    });
    const fixture = await readFile(fixturePath);
    const digest = createHash("sha256").update(fixture).digest("hex");
    assert.equal(episodeIdFromDigest(digest), episodeId);
    const failed: unknown = JSON.parse(
      await readFile(join(workspacePath, "episodes", episodeId, "transcript", "failed.json"), "utf8"),
    );
    assert.deepEqual(failed, { message: cactusMessage });
  });
  const name = mintedName(state);
  assert.deepEqual(state.lists, [[], [name], []]);
  assert.deepEqual(state.deleted, [name]);
  assert.deepEqual(
    state.log.find((argv) => argv[0] === "bots" && argv[1] === "create"),
    ["bots", "create", "--name", name, "--json"],
  );
  const added = state.log.find((argv) => argv[0] === "skills" && argv[1] === "add");
  assert.equal(added?.[2]?.endsWith("/poddrill"), true);
  assert.deepEqual(added === undefined ? undefined : [added[0], added[1], added[3]], [
    "skills",
    "add",
    "--json",
  ]);
});

test("default pass when failed.json names the missing needle module", async () => {
  const state = await withFake("needle", [], async (gbotPath) => {
    const report = await runHarness({ goal: "default", gbotPath });
    const expected: HarnessReport = {
      kind: "pass-default",
      transcript: "blocked-on-cactus-needle",
      episodeId,
      workspacePath,
    };
    assert.deepEqual(report, expected);
  });
  assert.deepEqual(state.deleted, [mintedName(state)]);
});

test("live cactus-needle failure is not a pass", async () => {
  await withFake("live-needle", [], async (gbotPath) => {
    const report = await runHarness({ goal: "live", gbotPath });
    assert.deepEqual(report, {
      kind: "fail",
      code: "transcript-failed-unexpectedly",
      workspacePath,
    });
  });
});

test("live pass only when labels and the topics summary exist", { timeout: 60_000 }, async () => {
  const state = await withFake("live", [], async (gbotPath) => {
    const report = await runHarness({ goal: "live", gbotPath });
    assert.deepEqual(report, {
      kind: "pass-live",
      episodeId,
      workspacePath,
    });
  });
  const name = mintedName(state);
  const threads = state.log.filter((argv) => argv[0] === "thread");
  assert.equal(state.threads, 2);
  assert.deepEqual(threads, [
    ["thread", name, "--json"],
    ["thread", name, "--after", "c1", "--json"],
  ]);
  const labels: unknown = JSON.parse(
    await readFile(join(workspacePath, "episodes", episodeId, "labels.json"), "utf8"),
  );
  assert.deepEqual(labels, [{ groupId: "g1", label: "Chamath" }]);
  const summary = await readFile(
    join(workspacePath, "episodes", episodeId, "summaries", "sm_0123456789abcdef.yaml"),
    "utf8",
  );
  assert.equal(summary.includes("summary: Chamath says the round was about rates."), true);
});
