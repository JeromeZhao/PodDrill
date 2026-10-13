import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  EpisodeTime,
  planSlices,
  projectSlices,
  SLICE_MS,
  type SliceRecord,
  type WhistleSpeech,
} from "../src/episode.ts";
import { openWhistleCall, providerIds, providerTransport, refuseUnwiredTransport } from "../src/provider.ts";
import { selectProvider } from "../src/transcribe.ts";

function speech(
  words: WhistleSpeech["words"],
  text: string,
): WhistleSpeech {
  return {
    kind: "speech",
    text,
    language: "en",
    ttftMs: 12,
    decodeTps: 40,
    words,
  };
}

describe("planSlices", () => {
  it("cuts a long file into 28 second slices with a 1 second overlap", () => {
    const slices = planSlices(60_000);
    assert.equal(slices.length, 3);
    assert.deepEqual(
      slices.map((slice) => [slice.startMs, slice.endMs, slice.keepStartMs, slice.keepEndMs]),
      [
        [0, 28_000, 0, 27_000],
        [27_000, 55_000, 27_000, 54_000],
        [54_000, 60_000, 54_000, 60_000],
      ],
    );
    for (const slice of slices) {
      assert.ok(slice.endMs - slice.startMs <= SLICE_MS);
    }
  });
});

describe("projectSlices", () => {
  it("places cue times on the episode clock and keeps Whistle metadata on the slice", () => {
    const plan = planSlices(30_000);
    const first = plan[0];
    assert.ok(first !== undefined);
    const record: SliceRecord = {
      plan: first,
      slicePath: "/tmp/slices/s0000.wav",
      whistle: speech(
        [
          { word: "Welcome", start: 0.48, end: 0.9, probability: 0.97 },
          { word: "back.", start: 0.9, end: 1.2, probability: 0.95 },
        ],
        "Welcome back.",
      ),
    };
    const projected = projectSlices([record]);
    assert.equal(projected.cues.length, 1);
    const cue = projected.cues[0];
    assert.ok(cue !== undefined);
    assert.equal(cue.start.milliseconds, 480);
    assert.equal(cue.end.milliseconds, 1200);
    assert.equal(cue.text, "Welcome back.");
    assert.match(projected.vtt, /^WEBVTT\n/);
    assert.match(projected.vtt, /00:00:00\.480 --> 00:00:01\.200/);
    const segment = projected.segments[0];
    assert.ok(segment !== undefined);
    assert.equal(segment.slicePath, "/tmp/slices/s0000.wav");
    assert.equal(segment.whistle.kind, "speech");
    if (segment.whistle.kind === "speech") {
      assert.equal(segment.whistle.ttftMs, 12);
      assert.equal(segment.whistle.words[0]?.probability, 0.97);
    }
    assert.equal(segment.words[0]?.cueId, cue.id);
  });

  it("drops the overlapped word from the earlier slice and keeps it on the later slice", () => {
    const plan = planSlices(60_000);
    const earlier = plan[0];
    const later = plan[1];
    assert.ok(earlier !== undefined && later !== undefined);
    const projected = projectSlices([
      {
        plan: earlier,
        slicePath: "/tmp/s0.wav",
        whistle: speech(
          [{ word: "edge.", start: 27.5, end: 27.8, probability: 0.9 }],
          "edge.",
        ),
      },
      {
        plan: later,
        slicePath: "/tmp/s1.wav",
        whistle: speech(
          [{ word: "edge.", start: 0.5, end: 0.8, probability: 0.91 }],
          "edge.",
        ),
      },
    ]);
    assert.equal(projected.cues.length, 1);
    assert.equal(projected.cues[0]?.pieces[0]?.sliceIndex, 1);
    assert.equal(projected.segments[0]?.words[0]?.kept, false);
    assert.equal(projected.segments[1]?.words[0]?.kept, true);
    assert.equal(projected.cues[0]?.start.milliseconds, 27_500);
  });

  it("closes a cue on a CJK full stop and starts the next cue after it", () => {
    const plan = planSlices(5_000);
    const only = plan[0];
    assert.ok(only !== undefined);
    const projected = projectSlices([
      {
        plan: only,
        slicePath: "/tmp/s0.wav",
        whistle: speech(
          [
            { word: "こんにちは", start: 0.1, end: 0.4, probability: 0.9 },
            { word: "です。", start: 0.4, end: 0.8, probability: 0.9 },
            { word: "次", start: 0.9, end: 1.1, probability: 0.9 },
          ],
          "こんにちは です。 次",
        ),
      },
    ]);
    assert.deepEqual(
      projected.cues.map((cue) => cue.text),
      ["こんにちは です。", "次"],
    );
  });

  it("extends a zero-length word so the cue end is later than the start", () => {
    const plan = planSlices(5_000);
    const only = plan[0];
    assert.ok(only !== undefined);
    const projected = projectSlices([
      {
        plan: only,
        slicePath: "/tmp/s0.wav",
        whistle: speech([{ word: "Hi.", start: 1, end: 1, probability: 0.5 }], "Hi."),
      },
    ]);
    const cue = projected.cues[0];
    assert.ok(cue !== undefined);
    assert.ok(cue.end.milliseconds > cue.start.milliseconds);
  });

  it("rebuilds the same WebVTT when the same records are projected twice", () => {
    const plan = planSlices(5_000);
    const only = plan[0];
    assert.ok(only !== undefined);
    const records: SliceRecord[] = [
      {
        plan: only,
        slicePath: "/tmp/s0.wav",
        whistle: speech([{ word: "Hi.", start: 0.2, end: 0.5, probability: 1 }], "Hi."),
      },
    ];
    const first = projectSlices(records);
    const second = projectSlices(records);
    assert.equal(first.vtt, second.vtt);
  });
});

describe("providers", () => {
  it("selects a local host for every provider and refuses an unwired transport", async () => {
    const profile = selectProvider("cursor-cloud");
    assert.equal(profile.providerId, "cursor-cloud");
    assert.deepEqual(providerIds, ["localhost", "grok-bot", "cursor-cloud"]);
    assert.throws(() => selectProvider("whisper"));
    for (const id of providerIds) {
      assert.equal(providerTransport(id), "local");
      const host = openWhistleCall(id, { fleetLimit: 1, modelFleet: {}, modelWeights: {} });
      await host.close();
    }
    assert.throws(() => refuseUnwiredTransport("grok-bot", "unwired"), {
      message: "grok-bot provider transport is not wired. poddrill setup refuses a provider that cannot transcribe.",
    });
    refuseUnwiredTransport("cursor-cloud", "local");
    assert.throws(() => openWhistleCall("localhost", { fleetLimit: 0, modelFleet: {}, modelWeights: {} }), {
      message: "fleet limit must be a positive integer, got 0",
    });
  });
});

describe("EpisodeTime", () => {
  it("shifts a slice-relative second onto the episode clock", () => {
    const time = EpisodeTime.shift(27_000, 0.5);
    assert.equal(time.milliseconds, 27_500);
  });
});
