import assert from "node:assert/strict";
import { access, mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { appendAudit, auditRecord, readAudit } from "../src/audit.ts";
import { episodeLayout, parseEpisodeId, type WorkspaceRoot } from "../src/workspace.ts";

const atStart = "2026-10-12T05:40:00.000Z";
const atCues = "2026-10-12T05:41:00.000Z";
const atParagraph = "2026-10-12T05:42:00.000Z";
const episodeId = "ep_0123456789abcdef";

describe("audit", () => {
  it("records a started episode, a cue page, and a posted paragraph", () => {
    assert.deepEqual(
      auditRecord(
        { op: "start", audioPath: "audio/clip.wav", language: "en" },
        {
          kind: "started",
          created: true,
          episode: { episodeId, sourcePath: "/tmp/source.wav", language: "en" },
        },
        atStart,
      ),
      {
        at: atStart,
        op: "start",
        request: { language: "en" },
        result: { kind: "started", created: true },
      },
    );
    assert.deepEqual(
      auditRecord(
        { op: "cues", episodeId, limit: 8 },
        {
          state: "present",
          episodeId,
          cues: [
            { id: "c0001", text: "alpha" },
            { id: "c0002", text: "beta" },
            { id: "c0003", text: "gamma" },
            { id: "c0004", text: "delta" },
            { id: "c0005", text: "epsilon" },
            { id: "c0006", text: "zeta" },
            { id: "c0007", text: "eta" },
            { id: "c0008", text: "theta" },
          ],
        },
        atCues,
      ),
      {
        at: atCues,
        op: "cues",
        request: { limit: 8 },
        result: { state: "present", count: 8, first: "c0001", last: "c0008" },
      },
    );
    assert.deepEqual(
      auditRecord(
        {
          op: "postParagraph",
          episodeId,
          summaryId: "sm_6b7be0fd5a237c45",
          body: { text: "do not copy", cues: ["c0002", "c0003"] },
        },
        {
          state: "present",
          summary: "the prose stays in the summary file",
          paragraphs: [{ index: 1, text: "do not copy", cues: ["c0002", "c0003"] }],
        },
        atParagraph,
      ),
      {
        at: atParagraph,
        op: "postParagraph",
        request: { summaryId: "sm_6b7be0fd5a237c45", cues: ["c0002", "c0003"] },
        result: { state: "present", index: 1 },
      },
    );
  });

  it("skips ping and a start that did not open an episode", () => {
    assert.equal(auditRecord({ op: "ping" }, { op: "pong" }, atStart), undefined);
    assert.equal(
      auditRecord(
        { op: "start", audioPath: "audio/clip.wav", language: "en" },
        { kind: "rejected", reason: "not-audio", message: "nope" },
        atStart,
      ),
      undefined,
    );
    assert.equal(
      auditRecord(
        { op: "start", audioPath: "audio/clip.wav" },
        { kind: "full", queueLength: 2, unfinished: [episodeId] },
        atStart,
      ),
      undefined,
    );
  });

  it("appends one line and leaves the file unchanged on a second read", async () => {
    const workspace = await openEpisode();
    try {
      const record = {
        at: atStart,
        op: "start" as const,
        request: { language: "en" },
        result: { kind: "started" as const, created: true },
      };
      await appendAudit(workspace.root, episodeId, record);
      const expected = { state: "present" as const, episodeId, records: [record] };
      assert.deepEqual(await readAudit(workspace.root, episodeId), expected);
      const before = await readFile(workspace.auditPath, "utf8");
      assert.deepEqual(await readAudit(workspace.root, episodeId), expected);
      assert.equal(await readFile(workspace.auditPath, "utf8"), before);
    } finally {
      await workspace.cleanup();
    }
  });

  it("fails a dump when the second line is not JSON and leaves the file unchanged", async () => {
    const workspace = await openEpisode();
    try {
      const record = {
        at: atStart,
        op: "start",
        request: { language: "en" },
        result: { kind: "started", created: true },
      };
      const text = `${JSON.stringify(record)}\nnot json\n`;
      await writeFile(workspace.auditPath, text);
      const before = await readFile(workspace.auditPath);
      assert.deepEqual(await readAudit(workspace.root, episodeId), {
        kind: "error",
        message: "the audit could not be read",
      });
      assert.deepEqual(await readFile(workspace.auditPath), before);
    } finally {
      await workspace.cleanup();
    }
  });

  it("reads an empty record list when the episode directory has no audit file", async () => {
    const workspace = await openEpisode();
    try {
      assert.deepEqual(await readAudit(workspace.root, episodeId), {
        state: "present",
        episodeId,
        records: [],
      });
      const missing = (error: unknown): boolean =>
        error instanceof Error && "code" in error && error.code === "ENOENT";
      await assert.rejects(access(workspace.auditPath), missing);
    } finally {
      await workspace.cleanup();
    }
  });
});

async function openEpisode(): Promise<{
  readonly root: WorkspaceRoot;
  readonly auditPath: string;
  readonly cleanup: () => Promise<void>;
}> {
  const root = (await realpath(await mkdtemp(join(tmpdir(), "poddrill-audit-")))) as WorkspaceRoot;
  const id = parseEpisodeId(episodeId);
  if (id === undefined) {
    throw new Error("episode id");
  }
  const layout = episodeLayout(root, id);
  await mkdir(layout.dir, { recursive: true });
  return {
    root,
    auditPath: layout.audit,
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}
