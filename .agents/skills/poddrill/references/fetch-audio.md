# Find and download episode audio

Find the episode audio and download it. Then write the 16-bit PCM mono 16 kHz WAV that `poddrill start` copies. Write that WAV outside this git repository. Delete the download after the WAV exists.

## Podcast feed

Search for the podcast feed. Take the audio URL for the episode from that feed.

Download that URL with the script in this skill. The file is `scripts/fetch-audio.mjs` next to `SKILL.md`. Pass that file to `node`.

```
node <skill-dir>/scripts/fetch-audio.mjs <url> <output-path> [expected-bytes]
```

The script refuses a destination inside the git tree that contains the script. Pass the byte length when the feed lists one. The script leaves an existing file of that size in place.

## yt-dlp

Ask the user before you install yt-dlp. Do that only when the feed has no audio URL, or the script did not write the file. Then install the current yt-dlp into the PodDrill Python and run that module. The version is unpinned. On a PEP 668 Python, install into the venv from `poddrill install-python`, or set `PODDRILL_PYTHON` to an interpreter that allows pip. A pipx install or a standalone yt-dlp binary also works. The printed line is the download path.

```
"$PODDRILL_PYTHON" -m pip install --upgrade yt-dlp
"$PODDRILL_PYTHON" -m yt_dlp -x --no-playlist --print after_move:filepath -o "<directory>/download.%(ext)s" "<page-url>"
```

Write `<directory>` outside this git repository. If that command does not get the audio, read [Usage and options](https://github.com/yt-dlp/yt-dlp#usage-and-options).

## Other audio

If the episode is not in a podcast feed and yt-dlp does not apply, use the tools you already have or improvise a way to fetch or record the audio. Then write the WAV below.

## Write the WAV

If the download path and the WAV path are the same file, pick a new WAV path first.

```
ffmpeg -hide_banner -loglevel error -nostdin -y -i <download> -ac 1 -ar 16000 -c:a pcm_s16le -f wav <episode>.wav
```

`<episode>.wav` is the path you pass to `poddrill start`. Delete `<download>` only after that WAV exists. Keep the WAV.
