# PodDrill

PodDrill is a tool that helps an agent to transcribe podcast audio into timed text, group the voices, and store a summary. It provides an agent skill and a set of best practices how to summarize a podcast efficiently and with clear structures.

## Quick start

### Set up your agent

Ask your agent:

```text
Set up PodDrill skill and tool: https://github.com/JeromeZhao/PodDrill
```

### Monitor a podcast

Set up a monitor on a podcast and summarize new episode:

```text
/PodDrill monitor <podcast name you want to monitor> podcast and summary newly released episode.
```

### Summarize your own way

Identify books mentioned in an episode and what it is about:

```text
/PodDrill for new episode from <podcast name you want to monitor>, extract what books it mentioned and what the book is about.
```

## For LLM and Agent
The supported install is the npm package. Run `npm install -g poddrill@0.3.2`. Do not use `@latest`. Cloning this repository is not required. If you clone it, set `GIT_TERMINAL_PROMPT=0`. The agent then follows the skill shipped in the package.

### Requirements

The computer that runs PodDrill needs:

- Node.js 20.19 or newer. Install the `.tar.gz` archive from `https://nodejs.org/dist/v20.19.0/`, or run `npx -y node@20.19.0`. The published CLI is plain JavaScript. The tests in this repository use `node --experimental-strip-types` and need a newer Node.
- `ffmpeg` on `PATH`.
- A Python interpreter with cactus-needle 3.2.0, numpy 2.5.4, and onnxruntime 1.31.0. The npm package named cactus-needle is a different package. `poddrill install-python` creates `~/.cache/poddrill/venv` and installs those pins. It uses `uv` when `uv` is on PATH, and otherwise `python3 -m venv`. `PODDRILL_PYTHON` selects another absolute interpreter, and setup stores that path in `poddrill.json`.
- The ECAPA and segmentation weight files. `poddrill fetch-weights` downloads `voxceleb_ECAPA512.onnx` and `segmentation.onnx`, checks each size and SHA-256, and writes them under `~/.cache/poddrill/ecapa/` and `~/.cache/poddrill/segmentation/`. `PODDRILL_EMBED_WEIGHTS` and `PODDRILL_SEGMENTATION_WEIGHTS` select other paths.

The transcript job diarizes the episode, then transcribes it. The embedding job runs after the transcript is ready.

`poddrill client doctor` prints a `fix` command for every check that is not ok. `poddrill bootstrap` runs `install-python`, `fetch-weights`, and `setup`.

Without `PODDRILL_WORKSPACE`, every command uses `~/poddrill`. `poddrill stop` stops the running owner.

Grok Bot cannot write its server entry. It prints the custom server to add: the absolute Node binary, `dist/cli.js`, and an env block. Add that server in the Grok Bot chat.

## Tests

`npm test` runs the unit tests. Those tests use `node --experimental-strip-types`.

`npm run test:smoke` runs a clean-home install, downloads the ECAPA and segmentation files, and transcribes a short generated clip through `dist/cli.js`. It needs `python3` with `ensurepip`, `ffmpeg`, and `espeak-ng`. If one of those is missing, the test skips and names the missing tool. Run `npm run test:smoke` on a computer that has those tools. Build `dist/` with `npm run build` first.

## License

MIT License. Copyright 2026 Jianyu Zhao.

The ECAPA weights are separate from this license. WeSpeaker ECAPA-TDNN512 pretrained on VoxCeleb. VoxCeleb is used under CC BY 4.0. The segmentation weights are separate from this license. pyannote segmentation-3.0 is MIT.
