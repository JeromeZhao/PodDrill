# Track podcast sources

Keep a SQLite file of sources and the episodes you have already seen. PodDrill keeps the transcript state. This file does not.

## Create the tables

```sql
CREATE TABLE source (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('rss', 'youtube')),
  locator TEXT NOT NULL,
  last_poll TEXT,
  latest_episode TEXT
);

CREATE TABLE episode (
  source_id TEXT NOT NULL REFERENCES source (id),
  remote_key TEXT NOT NULL,
  audio_sha256 TEXT CHECK (
    audio_sha256 IS NULL
    OR (
      length(audio_sha256) = 64
      AND audio_sha256 NOT GLOB '*[^0-9a-f]*'
    )
  ),
  PRIMARY KEY (source_id, remote_key)
);
```

`id` is a stable name you choose for that source.

`type` is `rss` or `youtube`.

`locator` is loose text. For `rss` it is the feed URL. For `youtube` it is the channel, playlist, or page URL.

`last_poll` is the time of the last poll, or null before the first one. Store it as UTC `YYYY-MM-DDTHH:MM:SSZ`.

`latest_episode` is the newest episode time from that poll, in the same form. Leave it null when the source has no episode time.

`remote_key` is how you recognize the same item on the next poll. For `rss` use the item guid. If the item has no guid, use the enclosure URL. For `youtube` use the video id.

`audio_sha256` is the sha256 of the file you pass to `poddrill start`, as 64 lowercase hex digits. Leave it null until that file exists. The episode id is `ep_` plus the first 16 characters of that hash.

## Poll

Read every row in `source`.

For `rss`, fetch the feed at `locator`. For `youtube`, list the videos at `locator`. Then set `last_poll` to the current UTC time. Set `latest_episode` to the newest episode time in that response. Leave `latest_episode` null when the response has no episode time.

For each item, look up `source_id` and `remote_key`.

If the row is missing, insert it with `audio_sha256` null. Download the audio as in [Find and download episode audio](fetch-audio.md). Hash the file you will pass to `poddrill start`, store that digest, and start the episode.

If the row exists and `audio_sha256` is null, the download did not finish. Download it, store the hash, and start the episode.

If `audio_sha256` is set, run `poddrill episode` with `ep_` plus the first 16 characters of that hash. The episode is processed when the transcript artifact state is `ready`. Read that from `poddrill episode`, `poddrill cues`, or the episode directory. Do not copy the artifact state, the progress, the paths, or the labels into this database.

A transcript that is missing or failed is not processed. Start it again with the CLI or MCP. Leave the hash in place.
