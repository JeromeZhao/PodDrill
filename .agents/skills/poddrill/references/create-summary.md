# Create an episode summary

Build one summary of an episode from its cues. Do this after the speaker groups are labeled. Do not write a summary from the transcript text. One episode can hold many summaries. Each one is a YAML file. You do not write that file yourself. Use the commands below.

Read the cues first with `poddrill cues`. Page them as in [Speaker assignment](assign-speakers.md).

The requirement is what the user asked you to summarize. Cite the cues that answer the requirement. You do not need to include a cue if it does not contribute to answering the requirement.

Before you write, mark the parts that are actually there. An episode can hold several. A part the cues do not support is left out.

### News commentary

News commentary is what happened, and the opinions on what happened. An opinion is that person's statement about what happened.

### Explanation

An explanation is how something works or why it is that way.

### Advice

Advice is what the listener should do, how they should decide, or how to get better.

### Claim

A claim is what someone holds, how they elaborate it, and the backup they offer. The elaboration is how they explain the claim. A claim can include a correction of who is speaking, and a place they stop.

### Discussion

A discussion is one topic, the perspectives on that topic, and how the people respond to each other. A perspective is a claim.

## Paragraphs and the summary

A cue belongs in a paragraph when it supports a part you marked for the requirement.

You decide how the parts sit in the paragraphs. A part may take more than one paragraph. Link the cues that belong to one part, and cover what holds that part together. The summary written from those paragraphs stays clear, concise, and structured.

Write `summary` after those paragraphs exist. Write it from the paragraph `text`.

## Writing

Write the words in `summary` and in each paragraph `text` by [Orwell's rules](orwell.md).

## Start the file

`startSummary` creates a new id and an empty file for that episode. The file stays under the episode. Starting again creates another summary.

```
poddrill start-summary <episodeId>
```

The MCP tool is `startSummary`. Pass `episodeId`.

Take `summaryId` from the reply. Do not invent an id.

`startSummary` works before the transcript is ready.

## Append a paragraph

A paragraph cites the cue ids it is about, in `cues`. List only those cues. A cue you leave out is not part of the paragraph, even when it sits between two cues you list. The paragraph `text` answers the requirement, written as in [Orwell's rules](orwell.md).

The cue words stay in the transcript.

The transcript artifact must be `ready`. Until then, append and replace report `not-ready` on `transcript`.

Do not send `index`. The first append is index 1. The next append is 2.

The file stores `cues` in transcript order. Omit `startMs` and `endMs`. `startMs` is the start of the earliest listed cue. `endMs` is the end of the latest listed cue. A time you send must match those cues.

```
poddrill post-paragraph <episodeId> <summaryId> '<json>'
```

```json
{ "text": "The guest says the city allows too few new homes near jobs.", "cues": ["c0002", "c0005"] }
```

The MCP tool is `postParagraph`. Pass `episodeId`, `summaryId`, `text`, and `cues`.

Two paragraphs may list the same cue.

## Replace a paragraph

`index` must already exist. A missing index is left uncreated. The new `text` follows [Orwell's rules](orwell.md). The new `cues` follow the same rules as an append.

```
poddrill put-paragraph <episodeId> <summaryId> '<json>'
```

```json
{ "index": 1, "text": "The guest says the city allows too few new homes near jobs.", "cues": ["c0002", "c0005"] }
```

The MCP tool is `putParagraph`. Pass `episodeId`, `summaryId`, `index`, `text`, and `cues`.

## Set the episode summary

Write this after the paragraphs. `setSummary` rejects a file that has no paragraphs.

`summary` is the prose for the whole episode. Those words follow [Orwell's rules](orwell.md). An empty string is rejected.

```
poddrill set-summary <episodeId> <summaryId> '<json>'
```

```json
{ "summary": "Cities allow too few new homes, and one renter's rent rose by a third." }
```

The MCP tool is `setSummary`. Pass `episodeId`, `summaryId`, and `summary`.

## Read it back

```
poddrill summary <episodeId> <summaryId>
```

The MCP tool is `summary`. Pass `episodeId` and `summaryId`.

`poddrill episode` lists each summary as `summaryId`. The paragraphs stay in the summary file.

## The file

The file is `summaries/<summaryId>.yaml` in the episode directory. It is YAML version 1. `summaryId` is the id `startSummary` returned.

```yaml
version: 1
episodeId: ep_ab12cd34ef567890
summaryId: sm_ab12cd34ef567890
summary: The guest says the city allows too few new homes.
paragraphs:
  - index: 1
    text: The guest says the city allows too few new homes near jobs.
    cues:
      - c0002
      - c0005
    startMs: 41000
    endMs: 88000
```

`version` is the number 1. Each paragraph has `index`, `text`, `cues`, `startMs`, and `endMs`. `cues` is the ordered set of cue ids that paragraph is about. The episode id, the summary id, and the cue times above are a constructed example.
