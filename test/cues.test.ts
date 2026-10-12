import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { JobQueue, type CuesRead, type LabelGroupsRead } from "../src/jobs.ts";
import { parseEpisodeId, setupWorkspace, type EpisodeId, type WorkspaceRoot } from "../src/workspace.ts";

function episodeId(): EpisodeId {
  const id = parseEpisodeId("ep_0123456789abcdef");
  if (id === undefined) {
    throw new Error("episode id");
  }
  return id;
}

function stamp(ms: number): string {
  const hours = Math.floor(ms / 3_600_000);
  const minutes = Math.floor((ms % 3_600_000) / 60_000);
  const seconds = Math.floor((ms % 60_000) / 1_000);
  const millis = ms % 1_000;
  const pad = (value: number): string => String(value).padStart(2, "0");
  return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}.${String(millis).padStart(3, "0")}`;
}

function cueId(index: number): string {
  return `c${String(index + 1).padStart(4, "0")}`;
}

function vtt(
  cues: readonly { readonly id: string; readonly startMs: number; readonly endMs: number; readonly text: string }[],
): string {
  const blocks = cues.map((cue) => [cue.id, `${stamp(cue.startMs)} --> ${stamp(cue.endMs)}`, cue.text].join("\n"));
  return ["WEBVTT", ...blocks].join("\n\n").concat("\n");
}

function presentCues(value: CuesRead): Extract<CuesRead, { readonly state: "present" }> {
  if (!("state" in value) || value.state !== "present") {
    throw new Error(JSON.stringify(value));
  }
  return value;
}

function presentLabels(value: LabelGroupsRead): {
  readonly labels: readonly { readonly groupId: string; readonly label: string }[];
} {
  if (!("state" in value) || value.state !== "present") {
    throw new Error(JSON.stringify(value));
  }
  return value;
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error: unknown) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

interface Seed {
  readonly id: EpisodeId;
  readonly dir: string;
  readonly queue: JobQueue;
  readonly cleanup: () => Promise<void>;
}

async function pause(ms: number): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function seed(
  transcript: string,
  stretches: readonly { readonly startMs: number; readonly endMs: number; readonly vector: readonly number[] }[] | undefined,
  hooks?: { readonly afterLabelRead?: () => Promise<void> },
): Promise<Seed> {
  const dir = await mkdtemp(join(tmpdir(), "poddrill-cues-"));
  const setup = await setupWorkspace({
    root: dir,
    provider: "localhost",
    queueLength: 1,
    ownerAlive: false,
  });
  if (setup.kind !== "ready") {
    throw new Error(setup.message);
  }
  const root: WorkspaceRoot = setup.report.dirs.root;
  const id = episodeId();
  const episodeDir = join(root, "episodes", id);
  await mkdir(join(episodeDir, "transcript"), { recursive: true });
  await mkdir(join(episodeDir, "embedding"), { recursive: true });
  const manifest = {
    episodeId: id,
    sha256: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    sourceName: "clip.wav",
    sourceFile: "source.wav",
    durationMs: 120_000,
    enqueuedAt: "2026-01-01T00:00:00.000Z",
  };
  await writeFile(join(episodeDir, "episode.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  await writeFile(join(episodeDir, "transcript", "transcript.vtt"), transcript);
  if (stretches !== undefined) {
    await writeFile(
      join(episodeDir, "embedding", "embedding.json"),
      `${JSON.stringify({ stretches }, null, 2)}\n`,
    );
  }
  const queue = await JobQueue.open(
    root,
    setup.report.config,
    {
      whistle: {
        transcribeSlice: () => Promise.reject(new Error("whistle should not run")),
      },
      embed: {
        prepare: () => Promise.resolve(),
        embedStretch: () => Promise.reject(new Error("embed should not run")),
      },
    },
    hooks,
  );
  return {
    id,
    dir: episodeDir,
    queue,
    cleanup: async () => {
      await queue.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

describe("cues", () => {
  it("keeps the transcript ready when groups.json does not exist", async () => {
    const transcript = vtt([{ id: "c0001", startMs: 100, endMs: 5_000, text: "talk done." }]);
    const seeded = await seed(transcript, undefined);
    try {
      const read = seeded.queue.episode(seeded.id);
      if (read.state !== "present") {
        throw new Error(JSON.stringify(read));
      }
      const transcriptArtifact = read.artifacts[0];
      if (transcriptArtifact === undefined) {
        throw new Error("missing transcript");
      }
      assert.deepEqual(transcriptArtifact, {
        artifact: "transcript",
        state: "ready",
        progress: 100,
        path: join(seeded.dir, "transcript", "transcript.vtt"),
      });
      assert.deepEqual(
        read.artifacts.map((artifact) => artifact.artifact),
        ["transcript", "embedding"],
      );
      assert.equal(await fileExists(join(seeded.dir, "groups.json")), false);
      assert.deepEqual(await seeded.queue.cues(seeded.id), {
        state: "not-ready",
        episodeId: seeded.id,
        on: "embedding",
      });
      assert.equal(await fileExists(join(seeded.dir, "groups.json")), false);
      assert.equal(await fileExists(join(seeded.dir, "labels.json")), false);
      assert.deepEqual(await seeded.queue.labelGroups(seeded.id, [{ groupId: "gc0001", label: "Ada" }]), {
        state: "not-ready",
        episodeId: seeded.id,
        on: "embedding",
      });
      assert.equal(await fileExists(join(seeded.dir, "groups.json")), false);
      const again = seeded.queue.episode(seeded.id);
      if (again.state !== "present") {
        throw new Error(JSON.stringify(again));
      }
      assert.deepEqual(again.artifacts[0], {
        artifact: "transcript",
        state: "ready",
        progress: 100,
        path: join(seeded.dir, "transcript", "transcript.vtt"),
      });
      assert.equal(await readFile(join(seeded.dir, "transcript", "transcript.vtt"), "utf8"), transcript);
      assert.deepEqual(await seeded.queue.cues("missing"), { state: "unknown", episodeId: "missing" });
    } finally {
      await seeded.cleanup();
    }
  });

  it("rejects a limit above 20 and pages eight cues by default", async () => {
    const cues = Array.from({ length: 21 }, (_, index) => ({
      id: cueId(index),
      startMs: index * 1_000,
      endMs: index * 1_000 + 100,
      text: `line ${index + 1}`,
    }));
    const seeded = await seed(vtt(cues), [{ startMs: 0, endMs: 30_000, vector: [1, 0] }]);
    try {
      assert.equal(await fileExists(join(seeded.dir, "groups.json")), false);
      assert.deepEqual(await seeded.queue.cues(seeded.id, { limit: 21 }), {
        kind: "rejected",
        reason: "limit",
        message: "limit must be an integer from 1 through 20",
      });
      assert.equal(await fileExists(join(seeded.dir, "groups.json")), false);
      const read = seeded.queue.episode(seeded.id);
      if (read.state !== "present") {
        throw new Error(JSON.stringify(read));
      }
      assert.deepEqual(read.artifacts[0], {
        artifact: "transcript",
        state: "ready",
        progress: 100,
        path: join(seeded.dir, "transcript", "transcript.vtt"),
      });

      const page = presentCues(await seeded.queue.cues(seeded.id));
      assert.deepEqual(
        page.cues.map((cue) => cue.id),
        ["c0001", "c0002", "c0003", "c0004", "c0005", "c0006", "c0007", "c0008"],
      );
      assert.deepEqual(page.cues[0], {
        id: "c0001",
        startMs: 0,
        endMs: 100,
        text: "line 1",
        groupId: "gc0001",
        nearestGroupId: null,
        nearestCosine: null,
      });
      assert.equal(JSON.stringify(page).includes("\"vector\""), false);

      const capped = presentCues(await seeded.queue.cues(seeded.id, { limit: 20 }));
      assert.equal(capped.cues.length, 20);
      assert.equal(capped.cues[0]?.id, "c0001");
      assert.equal(capped.cues[19]?.id, "c0020");
      const rest = presentCues(await seeded.queue.cues(seeded.id, { after: "c0008" }));
      assert.deepEqual(
        rest.cues.map((cue) => cue.id),
        ["c0009", "c0010", "c0011", "c0012", "c0013", "c0014", "c0015", "c0016"],
      );
      assert.deepEqual(await seeded.queue.cues(seeded.id, { after: "c9999" }), {
        state: "unknown",
        episodeId: seeded.id,
        cueId: "c9999",
      });
    } finally {
      await seeded.cleanup();
    }
  });

  it("keeps the group id of a merge just under 0.6 when the page size changes", async () => {
    const transcript = vtt([
      { id: "c0001", startMs: 1_000, endMs: 5_000, text: "near" },
      { id: "c0002", startMs: 7_000, endMs: 12_000, text: "also" },
      { id: "c0003", startMs: 14_000, endMs: 19_000, text: "far" },
    ]);
    const seeded = await seed(transcript, [
      { startMs: 1_000, endMs: 6_000, vector: [1000, 0] },
      { startMs: 7_000, endMs: 13_000, vector: [599, 801] },
      { startMs: 14_000, endMs: 20_000, vector: [-1000, 0] },
    ]);
    try {
      const narrow = presentCues(await seeded.queue.cues(seeded.id, { limit: 1 }));
      const wide = presentCues(await seeded.queue.cues(seeded.id, { limit: 8 }));
      assert.deepEqual(narrow.cues, [
        {
          id: "c0001",
          startMs: 1_000,
          endMs: 5_000,
          text: "near",
          groupId: "gc0001",
          nearestGroupId: "gc0003",
          nearestCosine: -1,
        },
      ]);
      assert.deepEqual(wide.cues, [
        {
          id: "c0001",
          startMs: 1_000,
          endMs: 5_000,
          text: "near",
          groupId: "gc0001",
          nearestGroupId: "gc0003",
          nearestCosine: -1,
        },
        {
          id: "c0002",
          startMs: 7_000,
          endMs: 12_000,
          text: "also",
          groupId: "gc0001",
          nearestGroupId: "gc0003",
          nearestCosine: -0.5988796372881421,
        },
        {
          id: "c0003",
          startMs: 14_000,
          endMs: 19_000,
          text: "far",
          groupId: "gc0003",
          nearestGroupId: "gc0001",
          nearestCosine: -0.8940914453408111,
        },
      ]);
      const groupsPath = join(seeded.dir, "groups.json");
      const stored = await readFile(groupsPath, "utf8");
      const tweaked = `${stored.trimEnd()} \n`;
      await writeFile(groupsPath, tweaked);
      const again = presentCues(await seeded.queue.cues(seeded.id, { limit: 20 }));
      assert.equal(again.cues[1]?.groupId, "gc0001");
      assert.equal(await readFile(groupsPath, "utf8"), tweaked);
    } finally {
      await seeded.cleanup();
    }
  });

  it("replaces only the listed labels and omits quote and ending from host names", async () => {
    const transcript = vtt([
      { id: "c0001", startMs: 1_000, endMs: 6_000, text: "one" },
      { id: "c0002", startMs: 8_000, endMs: 13_000, text: "two" },
      { id: "c0003", startMs: 15_000, endMs: 20_000, text: "three" },
      { id: "c0004", startMs: 30_000, endMs: 31_000, text: "yeah" },
    ]);
    const seeded = await seed(transcript, [
      { startMs: 1_000, endMs: 6_000, vector: [1, 0] },
      { startMs: 8_000, endMs: 13_000, vector: [1, 0] },
      { startMs: 15_000, endMs: 20_000, vector: [0, 1] },
    ]);
    try {
      const page = presentCues(await seeded.queue.cues(seeded.id, { limit: 8 }));
      assert.deepEqual(page.cues, [
        {
          id: "c0001",
          startMs: 1_000,
          endMs: 6_000,
          text: "one",
          groupId: "gc0001",
          nearestGroupId: "gc0003",
          nearestCosine: 0,
        },
        {
          id: "c0002",
          startMs: 8_000,
          endMs: 13_000,
          text: "two",
          groupId: "gc0001",
          nearestGroupId: "gc0003",
          nearestCosine: 0,
        },
        {
          id: "c0003",
          startMs: 15_000,
          endMs: 20_000,
          text: "three",
          groupId: "gc0003",
          nearestGroupId: "gc0001",
          nearestCosine: 0,
        },
        {
          id: "c0004",
          startMs: 30_000,
          endMs: 31_000,
          text: "yeah",
          groupId: "ungrouped",
          nearestGroupId: null,
          nearestCosine: null,
        },
      ]);
      const onlyFar = presentCues(await seeded.queue.cues(seeded.id, { groupId: "gc0003" }));
      assert.deepEqual(
        onlyFar.cues.map((cue) => cue.id),
        ["c0003"],
      );
      assert.deepEqual(await seeded.queue.cues(seeded.id, { groupId: "gmissing" }), {
        state: "unknown",
        episodeId: seeded.id,
        groupId: "gmissing",
      });

      assert.deepEqual(
        presentLabels(
          await seeded.queue.labelGroups(seeded.id, [
            { groupId: "gc0001", label: "Ada" },
            { groupId: "gc0003", label: "quote" },
          ]),
        ).labels,
        [
          { groupId: "gc0001", label: "Ada" },
          { groupId: "gc0003", label: "quote" },
        ],
      );
      const partial = presentLabels(
        await seeded.queue.labelGroups(seeded.id, [{ groupId: "gc0001", label: "Bea" }]),
      );
      assert.deepEqual(partial.labels, [
        { groupId: "gc0001", label: "Bea" },
        { groupId: "gc0003", label: "quote" },
      ]);
      const labelsPath = join(seeded.dir, "labels.json");
      const stored = `${JSON.stringify(
        {
          groups: [
            { groupId: "gc0001", label: "Bea" },
            { groupId: "gc0003", label: "quote" },
          ],
        },
        null,
        2,
      )}\n`;
      assert.equal(await readFile(labelsPath, "utf8"), stored);
      assert.deepEqual(await seeded.queue.labelGroups(seeded.id, [{ groupId: "gmissing", label: "Ada" }]), {
        state: "unknown",
        episodeId: seeded.id,
        groupId: "gmissing",
      });
      assert.equal(await readFile(labelsPath, "utf8"), stored);
      assert.equal(await readFile(join(seeded.dir, "transcript", "transcript.vtt"), "utf8"), transcript);

      assert.deepEqual(presentCues(await seeded.queue.cues(seeded.id, { hosts: true, limit: 20 })).hostNames, [
        "Bea",
      ]);
      await seeded.queue.labelGroups(seeded.id, [
        { groupId: "gc0001", label: "Sam" },
        { groupId: "gc0003", label: "Sam" },
      ]);
      assert.deepEqual(presentCues(await seeded.queue.cues(seeded.id, { hosts: true })).hostNames, ["Sam", "Sam"]);
      await seeded.queue.labelGroups(seeded.id, [
        { groupId: "gc0003", label: "ending" },
        { groupId: "ungrouped", label: "quote" },
      ]);
      assert.deepEqual(presentCues(await seeded.queue.cues(seeded.id, { hosts: true })).hostNames, ["Sam"]);
      assert.equal(await readFile(join(seeded.dir, "transcript", "transcript.vtt"), "utf8"), transcript);
    } finally {
      await seeded.cleanup();
    }
  });

  it("stores Ada and Bea when two labelGroups calls overlap on one episode", async () => {
    const transcript = vtt([
      { id: "c0001", startMs: 1_000, endMs: 6_000, text: "one" },
      { id: "c0002", startMs: 8_000, endMs: 13_000, text: "two" },
      { id: "c0003", startMs: 15_000, endMs: 20_000, text: "three" },
    ]);
    let reads = 0;
    let release = (): void => {
      throw new Error("label read was not armed");
    };
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const seeded = await seed(
      transcript,
      [
        { startMs: 1_000, endMs: 6_000, vector: [1, 0] },
        { startMs: 8_000, endMs: 13_000, vector: [1, 0] },
        { startMs: 15_000, endMs: 20_000, vector: [0, 1] },
      ],
      {
        afterLabelRead: async () => {
          reads += 1;
          if (reads === 1) {
            await held;
          }
        },
      },
    );
    const first = seeded.queue.labelGroups(seeded.id, [{ groupId: "gc0001", label: "Ada" }]);
    let second: Promise<LabelGroupsRead> | undefined;
    try {
      const started = Date.now();
      while (reads !== 1) {
        if (Date.now() - started > 2_000) {
          throw new Error("first labelGroups did not reach the label read");
        }
        await pause(5);
      }
      second = seeded.queue.labelGroups(seeded.id, [{ groupId: "gc0003", label: "Bea" }]);
      await pause(100);
      assert.equal(reads, 1);
      release();
      const ada = presentLabels(await first);
      const bea = presentLabels(await second);
      assert.deepEqual(ada.labels, [{ groupId: "gc0001", label: "Ada" }]);
      assert.deepEqual(bea.labels, [
        { groupId: "gc0001", label: "Ada" },
        { groupId: "gc0003", label: "Bea" },
      ]);
      assert.equal(
        await readFile(join(seeded.dir, "labels.json"), "utf8"),
        `${JSON.stringify(
          {
            groups: [
              { groupId: "gc0001", label: "Ada" },
              { groupId: "gc0003", label: "Bea" },
            ],
          },
          null,
          2,
        )}\n`,
      );
    } finally {
      release();
      await Promise.allSettled([first, second ?? Promise.resolve()]);
      await seeded.cleanup();
    }
  });
});
