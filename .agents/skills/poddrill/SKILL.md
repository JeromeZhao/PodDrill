---
name: poddrill
description: >-
  Transcribe a podcast episode into timed text, group the voices, and store
  a summary whose paragraphs cite that text. Use when the user says to set up
  PodDrill, fetch episode audio, start a transcript, label speakers, or write
  a summary. Do not use it to change the poddrill TypeScript.
---

# PodDrill

PodDrill maps an episode (the audio) to cues, clusters those cues into speaker groups, and stores summaries. You name the voices and you write the summary words. PodDrill stores the episode. When the user wants that episode handled, follow the order below. Do not skip a step.

Install once, with the sequence below. After that, read the one guide for the part you are doing. Leave the other guides unread. If an episode already has the asset you need, read it.

## Install on this computer

Do this once on the computer that will transcribe. Each step is safe to repeat. `localhost`, `grok-bot`, and `cursor-cloud` all run the local Python host on this computer. The provider id names that computer.

1. Install Node.js 20.19 or newer and `ffmpeg`. Use the Node `.tar.gz` archive from `https://nodejs.org/dist/v20.19.0/`, or run `npx -y node@20.19.0`. On macOS, `brew install ffmpeg`. On Linux, `sudo apt-get install -y ffmpeg`.

2. Install the npm package. Run `npm install -g poddrill@0.3.2`. Do not use `@latest`. Cloning the git repository is not required. If you clone it, set `GIT_TERMINAL_PROMPT=0`.

3. Run `poddrill install-python`. This creates `~/.cache/poddrill/venv` and installs cactus-needle 3.2.0, numpy 2.5.4, and onnxruntime 1.31.0. It uses `uv` when `uv` is on PATH, and otherwise `python3 -m venv`. The npm package named cactus-needle is a different package.

4. Run `poddrill fetch-weights`. This downloads `voxceleb_ECAPA512.onnx` from the pinned WeSpeaker commit, checks the byte size and SHA-256, and writes `~/.cache/poddrill/ecapa/voxceleb_ECAPA512.onnx`. WeSpeaker ECAPA-TDNN512 pretrained on VoxCeleb. VoxCeleb is used under CC BY 4.0. A later run leaves a matching file in place.

5. Run `poddrill client doctor --client cursor --json`. Use `grok_build` or `grok_bot` in place of `cursor` when that is the client. For every check whose `state` is `bad`, run the `fix` command on that check, then run doctor again. Skip a check whose `state` is `optional`. Do not install it. Do not mention it. Do not ask the user about it. `workspace` stays `pending` until setup. Stop this loop when doctor exits 0, or when the only `bad` check is `link`.

6. Run `poddrill setup --provider localhost --queue-length 4`. Without `PODDRILL_WORKSPACE`, setup and every other command use `~/poddrill`. When the episode language is `ja`, `ko`, or `zh`, read the weights guide before this command. Ask the user before you install anything that guide names.

   `poddrill bootstrap --provider localhost --queue-length 4` runs steps 3, 4, and 6.

7. Register the client. Run `poddrill client plan --client cursor --json`. After that plan is approved, run `poddrill client apply --yes --client cursor`. Grok Bot prints a sentence with the absolute Node binary, `dist/cli.js`, and an env block (`PATH`, `PODDRILL_PYTHON`, `PODDRILL_WORKSPACE`, `PODDRILL_EMBED_WEIGHTS`). Add that custom server in the Grok Bot chat. It does not write a config file.

8. Run `poddrill client doctor --client cursor --json` again. Exit 0 means every required check is ok.

A later refresh of clients that already have an entry is `poddrill client plan --linked --json`, then `poddrill client apply --yes --linked` after approval.

## Python

`PODDRILL_PYTHON` selects the interpreter. Pass `--python` or set `PODDRILL_PYTHON` on setup to store an absolute path in `poddrill.json`. Otherwise PodDrill uses `~/.cache/poddrill/venv/bin/python` when that file exists, then `python3`.

## Stop

`poddrill stop` stops the running owner. Setup rejects a change while the owner is running. Run `poddrill stop` before you change the provider, queue length, fleet limit, or embedding limit.

## Cues

An asset maps each segment of the audio to text. That segment is a cue. A cue has the text and the times. You read the cues. You do not invent the text or the times.

Read cues only after the embedding is ready. A ready transcript can still be not-ready for cues.

## Speaker groups

An asset clusters cues that sound like one voice. That cluster is a speaker group. The embedding stage writes the groups before that stage is ready. You assign the group a name, `quote`, `ending`, or `undetermined`. The utility does not choose the name.

Label the speaker groups before you write a summary. Do not write a summary from the transcript text alone.

The order is `poddrill start`, then poll `poddrill episode` until the transcript and the embedding are `ready`, then `poddrill cues` and `poddrill label-groups` from the speaker guide, then `poddrill start-summary`, `poddrill post-paragraph`, and `poddrill set-summary` from the summary guide. Present the text from `poddrill summary`. A summary written in chat before those commands is not the result.

## Summaries

Summary is an asset of an episode. An episode can have multiple summary assets. You use the cues when you write a summary. PodDrill stores paragraphs that cite cues, then an episode summary written from the paragraph text. You choose which cues to include and you write the words. You do not write the file yourself.

## The episode

You keep the source list. The utility keeps the episode. The episode holds the transcript, the cues, the groups, the labels, and the summaries in your filesystem. Do not copy artifact state, progress, paths, or labels into the source list.

## Start an episode

Write the WAV at `<workspace>/audio/<file>.wav`. `poddrill start` resolves the path from the workspace root and rejects a file outside `audio/`.

Pass `--language <code>` on `poddrill start` when the episode is not English. The code is `en`, `de`, `fr`, `es`, `it`, `nl`, `pl`, `ja`, `ko`, or `zh`.

`poddrill start` returns before the transcript exists. Poll `poddrill episode <id>` until the transcript artifact `state` is `ready` or `failed`. The id is `ep_` plus the first 16 hex characters of the sha256 of the file bytes.

The transcript is done when that `state` is `ready`. Exit 0 does not mean the transcript is done. If the transcript or the embedding is missing or `failed`, pass the same WAV to `poddrill start` again. The episode id does not change. `created` is false, and the failed artifact runs again.

## Read a result

Parse the JSON line on stdout. `episode` exits 0 when the id is unknown. `not-ready` exits 0. `start` exits 1 when `kind` is `rejected` or `full`. MCP returns that same JSON. `isError` is true only when the text starts with `{"kind":"error"`.

`poddrill --help` and `poddrill --version` print plain text and exit 0.

## Present the summary

Present the text returned by `poddrill summary`. Match the format the user asked for. Do not replace that text with a summary you wrote from the transcript.

## Guides

Each file tells you how to do one part of the task.

- For a feed or a YouTube page, and for telling a new episode from one already handed to poddrill, read [references/track-sources.md](references/track-sources.md).
- For finding the audio, downloading it, and writing the 16 kHz WAV, read [references/fetch-audio.md](references/fetch-audio.md).
- For Japanese, Korean, or Chinese weights, read [references/select-models.md](references/select-models.md).
- Before any summary, read [references/assign-speakers.md](references/assign-speakers.md) and label the groups.
- After those labels, read [references/create-summary.md](references/create-summary.md) and store the summary with its commands.

## Finish

Name the episode id, the transcript `state`, and the paths you wrote.
