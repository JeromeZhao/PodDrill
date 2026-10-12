---
name: poddrill
description: >-
  Transcribe a podcast episode into timed text, group the voices, and store
  a summary whose paragraphs cite that text. The agent reads the text, names
  the voices, and writes the summary words. PodDrill stores the episode.
  Use when fetching episode audio, starting a transcript, labeling speakers,
  or writing a summary. Do not use it to change the poddrill TypeScript.
---

# PodDrill

PodDrill is a toolset to make transcription and summary of podcast audio streamlined and structured. You may also use it for any other audio. It maps an episode (the audio) to cues, clusters those cues into speaker groups, and stores summaries. You decide how to use the toolset to answer user's request of audio summary.

Set up a workspace once, when it is missing. After that, read the one guide for the part you are doing. Leave the other guides unread. If an episode already has the asset you need, read it. Do not reprocess the audio again.

## Cues

An asset maps each segment of the audio to text. That segment is a cue. A cue has the text and the times. You read the cues. You do not invent the text or the times.

Read cues only after the embedding is ready. A ready transcript can still be not-ready for cues.

## Speaker groups

An asset clusters cues that sound like one voice. That cluster is a speaker group. You assign the group a name, `quote`, `ending`, or `undetermined`. The utility does not choose the name.

A summary does not require those labels.

## Summaries

Summary is an asset of an episode. An episode can have multiple summary asset. You use the cues when you write a summary. PodDrill stores paragraphs that cite cues, then an episode summary written from the paragraph text. You choose which cues to include and you write the words. You do not write the file yourself.

## The episode

You keep the source list. The utility keeps the episode. The episode holds the transcript, the cues, the groups, the labels, and the summaries in your filesystem. Do not copy artifact state, progress, paths, or labels into the source list.

## Set up once

Set `PODDRILL_WORKSPACE` to a directory outside the git tree that contains this skill. Without that variable, `setup` uses the current directory and every other command uses `~/poddrill`.

Run setup once in that workspace. The provider is the computer you are running on.

```
poddrill setup --provider <id> --queue-length 4
```

If you are the Grok Bot agent, `<id>` is `grok-bot`. If you are the Cursor cloud agent, `<id>` is `cursor-cloud`. That computer is the host. Otherwise `<id>` is `localhost`.

For `ja`, `ko`, or `zh`, read the weights guide and pass `--model-weights` on that same setup command. `en`, `de`, `fr`, `es`, `it`, `nl`, and `pl` do not need weights.

Stop the owner before you change setup. A running owner rejects a different provider, queue length, fleet limit, or embedding limit.

## Start an episode

Write the WAV at `<workspace>/audio/<file>.wav`. `poddrill start` resolves the path from the workspace root and rejects a file outside `audio/`.

Pass `--language <code>` on `poddrill start` when the episode is not English. The code is `en`, `de`, `fr`, `es`, `it`, `nl`, `pl`, `ja`, `ko`, or `zh`.

`poddrill start` returns before the transcript exists. Poll `poddrill episode <id>` until the transcript artifact `state` is `ready` or `failed`. The id is `ep_` plus the first 16 hex characters of the sha256 of the file bytes.

The transcript is done when that `state` is `ready`. Exit 0 does not mean the transcript is done. If it is missing or `failed`, pass the same WAV to `poddrill start` again. The episode id does not change.

## Read a result

Parse the JSON line on stdout. `episode` exits 0 when the id is unknown. `not-ready` exits 0. `start` exits 1 when `kind` is `rejected` or `full`. MCP returns that same JSON. `isError` is true only when the text starts with `{"kind":"error"`.

## Present the summary

Present the summary in the format preferred or prescribed by users, but always grounded by the summary constructed via poddrill.

## Guides

Each file tells you how to do one part of the task.

- For a feed or a YouTube page, and for telling a new episode from one already handed to poddrill, read [references/track-sources.md](references/track-sources.md).
- For finding the audio, downloading it, and writing the 16 kHz WAV, read [references/fetch-audio.md](references/fetch-audio.md).
- For Japanese, Korean, or Chinese weights, read [references/select-models.md](references/select-models.md).
- For a voice name, a quote, an ending, or cues left undetermined, read [references/assign-speakers.md](references/assign-speakers.md).
- For an episode summary, read [references/create-summary.md](references/create-summary.md).

## Finish

Name the episode id, the transcript `state`, and the paths you wrote.
