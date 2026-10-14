import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { JobQueue } from "../src/jobs.ts";
import { parseEpisodeId, setupWorkspace, type EpisodeId } from "../src/workspace.ts";

const EPISODE = "ep_0123456789abcdef";
const PLANTED = "sm_0123456789abcdef";

function episodeId(): EpisodeId {
  const id = parseEpisodeId(EPISODE);
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

function vtt(
  cues: readonly { readonly id: string; readonly startMs: number; readonly endMs: number; readonly text: string }[],
): string {
  const blocks = cues.map((cue) => [cue.id, `${stamp(cue.startMs)} --> ${stamp(cue.endMs)}`, cue.text].join("\n"));
  return ["WEBVTT", ...blocks].join("\n\n").concat("\n");
}

const CUES = [
  { id: "c0010", startMs: 100, endMs: 250, text: "one" },
  { id: "c0003", startMs: 260, endMs: 350, text: "gap" },
  { id: "c0002", startMs: 400, endMs: 800, text: "two" },
];

const FIRST = {
  index: 1,
  text: "First line.",
  cues: ["c0010", "c0002"],
  startMs: 100,
  endMs: 800,
};

const SECOND = {
  index: 2,
  text: "Second line.",
  cues: ["c0002"],
  startMs: 400,
  endMs: 800,
};

function emptyYaml(summaryId: string): string {
  return [
    "version: 1",
    `episodeId: ${EPISODE}`,
    `summaryId: ${summaryId}`,
    "summary: \"\"",
    "paragraphs: []",
    "",
  ].join("\n");
}

interface Seed {
  readonly id: EpisodeId;
  readonly dir: string;
  readonly queue: JobQueue;
  readonly cleanup: () => Promise<void>;
}

function hosts(): {
  readonly whistle: { transcribeSlice: () => Promise<never> };
  readonly embed: { prepare: () => Promise<void>; embedStretch: () => Promise<never> };
  readonly diarize: { prepare: () => Promise<void>; diarize: () => Promise<never> };
} {
  return {
    whistle: {
      transcribeSlice: () => Promise.reject(new Error("whistle should not run")),
    },
    embed: {
      prepare: () => Promise.resolve(),
      embedStretch: () => Promise.reject(new Error("embed should not run")),
    },
    diarize: {
      prepare: () => Promise.resolve(),
      diarize: () => Promise.reject(new Error("diarize should not run")),
    },
  };
}

async function seed(transcriptReady: boolean): Promise<Seed> {
  const dir = await mkdtemp(join(tmpdir(), "poddrill-summary-"));
  const setup = await setupWorkspace({
    root: dir,
    provider: "localhost",
    queueLength: 1,
    ownerAlive: false,
  });
  if (setup.kind !== "ready") {
    throw new Error(setup.message);
  }
  const root = setup.report.dirs.root;
  const id = episodeId();
  const episodeDir = join(root, "episodes", id);
  await mkdir(join(episodeDir, "transcript"), { recursive: true });
  const manifest = {
    episodeId: id,
    sha256: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    sourceName: "clip.wav",
    sourceFile: "source.wav",
    durationMs: 120_000,
    enqueuedAt: "2026-01-01T00:00:00.000Z",
  };
  await writeFile(join(episodeDir, "episode.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  if (transcriptReady) {
    await writeFile(join(episodeDir, "transcript", "transcript.vtt"), vtt(CUES));
    await mkdir(join(episodeDir, "embedding"), { recursive: true });
    await writeFile(join(episodeDir, "embedding", "embedding.json"), "{}\n");
    await writeFile(join(episodeDir, "groups.json"), "{\"cues\":[]}\n");
  } else {
    await writeFile(
      join(episodeDir, "transcript", "failed.json"),
      `${JSON.stringify({ message: "transcript failed" })}\n`,
    );
  }
  const queue = await JobQueue.open(root, setup.report.config, hosts());
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

function summaryPath(seeded: Seed, summaryId: string): string {
  return join(seeded.dir, "summaries", `${summaryId}.yaml`);
}

function opened(seeded: Seed, summaryId: string, summary = "", paragraphs: readonly (typeof FIRST)[] = []) {
  return {
    state: "present" as const,
    episodeId: seeded.id,
    version: 1 as const,
    summaryId,
    summary,
    paragraphs,
  };
}

async function begin(seeded: Seed): Promise<string> {
  const started = await seeded.queue.startSummary(seeded.id);
  if (started.state !== "present") {
    throw new Error(JSON.stringify(started));
  }
  return started.summaryId;
}

describe("summaries", () => {
  it("starts a YAML file that starts with version 1", async () => {
    const seeded = await seed(true);
    try {
      const started = await seeded.queue.startSummary(seeded.id);
      if (started.state !== "present") {
        throw new Error(JSON.stringify(started));
      }
      assert.deepEqual(started, opened(seeded, started.summaryId));
      const text = await readFile(summaryPath(seeded, started.summaryId), "utf8");
      assert.equal(text, emptyYaml(started.summaryId));
      assert.equal(text.startsWith("version: 1\n"), true);
      assert.throws(() => JSON.parse(text), SyntaxError);
      const read = seeded.queue.episode(seeded.id);
      if (read.state !== "present") {
        throw new Error(JSON.stringify(read));
      }
      assert.deepEqual(read.summaries, [{ summaryId: started.summaryId }]);
    } finally {
      await seeded.cleanup();
    }
  });

  it("creates another summary and leaves the first in place", async () => {
    const seeded = await seed(true);
    try {
      const id = await begin(seeded);
      const posted = await seeded.queue.postParagraph(seeded.id, id, {
        text: "First line.",
        cues: ["c0010", "c0002"],
      });
      assert.deepEqual(posted, opened(seeded, id, "", [FIRST]));
      const again = await begin(seeded);
      assert.notEqual(again, id);
      assert.deepEqual(await seeded.queue.summary(seeded.id, id), opened(seeded, id, "", [FIRST]));
    } finally {
      await seeded.cleanup();
    }
  });

  it("lists two summaries sorted by summary id", async () => {
    const seeded = await seed(true);
    try {
      const first = await begin(seeded);
      const second = await begin(seeded);
      const read = seeded.queue.episode(seeded.id);
      if (read.state !== "present") {
        throw new Error(JSON.stringify(read));
      }
      const listed = [first, second].sort();
      assert.deepEqual(
        read.summaries,
        listed.map((summaryId) => ({ summaryId })),
      );
      const topics = await readFile(summaryPath(seeded, second), "utf8");
      assert.equal(topics.startsWith("version: 1\n"), true);
    } finally {
      await seeded.cleanup();
    }
  });

  it("replaces only the summary text", async () => {
    const seeded = await seed(true);
    try {
      const id = await begin(seeded);
      await seeded.queue.postParagraph(seeded.id, id, {
        text: "First line.",
        cues: ["c0010", "c0002"],
      });
      assert.deepEqual(await seeded.queue.setSummary(seeded.id, id, "A short recap."), opened(
        seeded,
        id,
        "A short recap.",
        [FIRST],
      ));
      assert.deepEqual(await seeded.queue.setSummary(seeded.id, "sm_0000000000000000", "Nope."), {
        state: "unknown",
        episodeId: seeded.id,
        summaryId: "sm_0000000000000000",
      });
      assert.deepEqual(await seeded.queue.setSummary(seeded.id, id, ""), {
        kind: "error",
        message: "summary must be a non-empty string",
      });
      assert.deepEqual(
        await seeded.queue.summary(seeded.id, id),
        opened(seeded, id, "A short recap.", [FIRST]),
      );
    } finally {
      await seeded.cleanup();
    }
  });

  it("assigns index 1 then 2 and fills cue times", async () => {
    const seeded = await seed(true);
    try {
      const id = await begin(seeded);
      assert.deepEqual(
        await seeded.queue.postParagraph(seeded.id, id, {
          text: "First line.",
          cues: ["c0010", "c0002"],
        }),
        opened(seeded, id, "", [FIRST]),
      );
      assert.deepEqual(
        await seeded.queue.postParagraph(seeded.id, id, {
          text: "Second line.",
          cues: ["c0002"],
        }),
        opened(seeded, id, "", [FIRST, SECOND]),
      );
    } finally {
      await seeded.cleanup();
    }
  });

  it("replaces index 1 and leaves index 2", async () => {
    const seeded = await seed(true);
    try {
      const id = await begin(seeded);
      await seeded.queue.postParagraph(seeded.id, id, {
        text: "First line.",
        cues: ["c0010", "c0002"],
      });
      await seeded.queue.postParagraph(seeded.id, id, {
        text: "Second line.",
        cues: ["c0002"],
      });
      const rewritten = {
        index: 1,
        text: "Rewritten.",
        cues: ["c0010"],
        startMs: 100,
        endMs: 250,
      };
      assert.deepEqual(
        await seeded.queue.putParagraph(seeded.id, id, {
          index: 1,
        text: "Rewritten.",
        cues: ["c0010"],
        }),
        opened(seeded, id, "", [rewritten, SECOND]),
      );
    } finally {
      await seeded.cleanup();
    }
  });

  it("does not append when put names a missing index", async () => {
    const seeded = await seed(true);
    try {
      const id = await begin(seeded);
      await seeded.queue.postParagraph(seeded.id, id, {
        text: "First line.",
        cues: ["c0010", "c0002"],
      });
      const before = await seeded.queue.summary(seeded.id, id);
      assert.deepEqual(await seeded.queue.putParagraph(seeded.id, id, {
        index: 3,
        text: "Extra.",
        cues: ["c0010", "c0002"],
      }), {
        kind: "error",
        message: "putParagraph index does not exist",
      });
      assert.deepEqual(await seeded.queue.summary(seeded.id, id), before);
    } finally {
      await seeded.cleanup();
    }
  });

  it("rejects a post body that includes index", async () => {
    const seeded = await seed(true);
    try {
      const id = await begin(seeded);
      const before = await readFile(summaryPath(seeded, id), "utf8");
      assert.deepEqual(
        await seeded.queue.postParagraph(seeded.id, id, {
          index: 1,
          text: "First line.",
          cues: ["c0010", "c0002"],
        }),
        { kind: "error", message: "postParagraph rejects index" },
      );
      assert.equal(await readFile(summaryPath(seeded, id), "utf8"), before);
    } finally {
      await seeded.cleanup();
    }
  });

  it("stores cited cues in transcript order and leaves the gap out", async () => {
    const seeded = await seed(true);
    try {
      const id = await begin(seeded);
      assert.deepEqual(
        await seeded.queue.postParagraph(seeded.id, id, {
          text: "First line.",
          cues: ["c0002", "c0010"],
        }),
        opened(seeded, id, "", [FIRST]),
      );
    } finally {
      await seeded.cleanup();
    }
  });

  it("rejects a cue listed twice and does not write", async () => {
    const seeded = await seed(true);
    try {
      const id = await begin(seeded);
      const before = await readFile(summaryPath(seeded, id), "utf8");
      assert.deepEqual(
        await seeded.queue.postParagraph(seeded.id, id, {
          text: "Twice.",
          cues: ["c0010", "c0010"],
        }),
        { kind: "error", message: "a cue is listed twice" },
      );
      assert.equal(await readFile(summaryPath(seeded, id), "utf8"), before);
    } finally {
      await seeded.cleanup();
    }
  });

  it("rejects the episode summary before any paragraph", async () => {
    const seeded = await seed(true);
    try {
      const id = await begin(seeded);
      const before = await readFile(summaryPath(seeded, id), "utf8");
      assert.deepEqual(await seeded.queue.setSummary(seeded.id, id, "Too soon."), {
        kind: "error",
        message: "write the paragraphs before the episode summary",
      });
      assert.equal(await readFile(summaryPath(seeded, id), "utf8"), before);
    } finally {
      await seeded.cleanup();
    }
  });

  it("rejects a sent time that disagrees with the cue", async () => {
    const seeded = await seed(true);
    try {
      const id = await begin(seeded);
      const before = await readFile(summaryPath(seeded, id), "utf8");
      assert.deepEqual(
        await seeded.queue.postParagraph(seeded.id, id, {
          text: "First line.",
          cues: ["c0010", "c0002"],
          startMs: 101,
        }),
        { kind: "error", message: "startMs does not match the cue" },
      );
      assert.equal(await readFile(summaryPath(seeded, id), "utf8"), before);
    } finally {
      await seeded.cleanup();
    }
  });

  it("reports not-ready on transcript and still starts", async () => {
    const seeded = await seed(false);
    try {
      assert.deepEqual(
        await seeded.queue.postParagraph(seeded.id, PLANTED, {
          text: "First line.",
          cues: ["c0010", "c0002"],
        }),
        { state: "not-ready", episodeId: seeded.id, on: "transcript" },
      );
      const started = await seeded.queue.startSummary(seeded.id);
      if (started.state !== "present") {
        throw new Error(JSON.stringify(started));
      }
      assert.deepEqual(started, opened(seeded, started.summaryId));
      assert.equal(await readFile(summaryPath(seeded, started.summaryId), "utf8"), emptyYaml(started.summaryId));
    } finally {
      await seeded.cleanup();
    }
  });

  it("fails summary() on a YAML alias without throwing", async () => {
    const seeded = await seed(true);
    try {
      const alias = [
        "version: &v 1",
        `episodeId: ${EPISODE}`,
        "summaryId: *v",
        "summary: \"\"",
        "paragraphs: []",
        "",
      ].join("\n");
      await mkdir(join(seeded.dir, "summaries"), { recursive: true });
      await writeFile(summaryPath(seeded, PLANTED), alias);
      assert.deepEqual(await seeded.queue.summary(seeded.id, PLANTED), {
        kind: "error",
        message: "the summary could not be read",
      });
      const started = await seeded.queue.startSummary(seeded.id);
      if (started.state !== "present") {
        throw new Error(JSON.stringify(started));
      }
      assert.notEqual(started.summaryId, PLANTED);
      assert.equal(await readFile(summaryPath(seeded, PLANTED), "utf8"), alias);
    } finally {
      await seeded.cleanup();
    }
  });

  it("fails summary() on a js function tag without throwing", async () => {
    const seeded = await seed(true);
    try {
      const tagged = [
        "version: 1",
        `episodeId: ${EPISODE}`,
        `summaryId: ${PLANTED}`,
        "summary: !!js/function 'function () { return 1 }'",
        "paragraphs: []",
        "",
      ].join("\n");
      await mkdir(join(seeded.dir, "summaries"), { recursive: true });
      await writeFile(summaryPath(seeded, PLANTED), tagged);
      assert.deepEqual(await seeded.queue.summary(seeded.id, PLANTED), {
        kind: "error",
        message: "the summary could not be read",
      });
    } finally {
      await seeded.cleanup();
    }
  });

  it("fails summary() when the version is 2", async () => {
    const seeded = await seed(true);
    try {
      const versionTwo = [
        "version: 2",
        `episodeId: ${EPISODE}`,
        `summaryId: ${PLANTED}`,
        "summary: \"\"",
        "paragraphs: []",
        "",
      ].join("\n");
      await mkdir(join(seeded.dir, "summaries"), { recursive: true });
      await writeFile(summaryPath(seeded, PLANTED), versionTwo);
      assert.deepEqual(await seeded.queue.summary(seeded.id, PLANTED), {
        kind: "error",
        message: "the summary could not be read",
      });
    } finally {
      await seeded.cleanup();
    }
  });
});
