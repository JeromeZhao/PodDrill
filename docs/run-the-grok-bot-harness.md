# Run the Grok Bot harness

You run one command. The command creates one throwaway bot, asks that bot to use poddrill, and scores the files in a temp workspace. Stdout is one JSON report. The report does not include bot chat text.

## Before you start

Sign in to the Grok Bot desktop app and leave it running.

`gbot` must list bots. `grok-bot-cli` 0.12.4 rejects gateway descriptor version 3. Grok Bot 0.70.2 writes version 3. If `gbot bots list` prints `Unsupported Grok Bot gateway descriptor version 3`, pass `--gbot` with a build that accepts version 3.

The default goal does not need a finished transcript. A live run needs `ffmpeg`, the Python package `cactus-needle` 3.2.0, and the ECAPA file `~/.cache/poddrill/ecapa/voxceleb_ECAPA512.onnx`. `cactus-needle` is a Python package. It is not the npm package of the same name.

## Run the default goal

From the repo root, run:

```bash
node --experimental-strip-types test/harness/run.ts
```

Exit code 0 means the workspace passed. Stdout is one object with `"kind":"pass-default"`. The `transcript` field is `blocked-on-cactus-needle` or `ready`.

The command writes three paths under `$TMPDIR` and does not write `~/poddrill`.

- `poddrill-harness-workspace` is the workspace.
- `poddrill-harness-lease.json` is the crash journal. A later run deletes only the bot named there.
- `poddrill-harness-fixture.wav` is the short silent wav for the default goal.

## Run the live goal

Run:

```bash
node --experimental-strip-types test/harness/run.ts --live
```

Exit code 0 and `"kind":"pass-live"` mean the workspace has a transcript, an embedding, speaker labels, and one summary. The prompt asks for the topics, the perspectives, and who held them.

The live prompt downloads one pinned All-In enclosure. It does not pick whatever episode is newest on the day you run it. The deadline is 6 hours. The default deadline is 3 minutes.

To point the command at a `gbot` binary that is not on `PATH`, add `--gbot` and the path. Any other argument exits 2 and does not call `gbot`.

## Read a failure

Exit code 1 means the report `kind` is `fail`. Read the `code` field. The command deletes the bot it created when that delete succeeds. If the bot is still on the roster, `code` is `bot-not-deleted` and the lease file stays.

## Run the automated test

The test does not call the desktop app. It writes a fake `gbot` under a temp directory.

```bash
node --experimental-strip-types --test test/harness/run.test.ts
```

A pass prints `pass` for 7 tests and `fail 0`.
