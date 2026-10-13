# PodDrill

PodDrill is a skill that transcribes episode audio into timed text, groups the voices, and stores a summary.

## Say this

Copy this to the agent.

```text
Set up PodDrill on this computer.
```

The supported install is the npm package. Read the published `version` and run `npm install -g poddrill@<version>`. Cloning this repository is not required. If you clone it, set `GIT_TERMINAL_PROMPT=0`. The agent then follows the skill shipped in the package.

## Requirements

The computer that runs PodDrill needs:

- Node.js 20.19 or newer. Install the `.tar.gz` archive from `https://nodejs.org/dist/v20.19.0/`, or run `npx -y node@20.19.0`. The published CLI is plain JavaScript. The tests in this repository use `node --experimental-strip-types` and need a newer Node.
- `ffmpeg` on `PATH`.
- A Python interpreter with cactus-needle 3.2.0, numpy 2.5.4, and onnxruntime 1.31.0. The npm package named cactus-needle is a different package. `poddrill install-python` creates `~/.cache/poddrill/venv` and installs those pins. It uses `uv` when `uv` is on PATH, and otherwise `python3 -m venv`. `PODDRILL_PYTHON` selects another absolute interpreter, and setup stores that path in `poddrill.json`.
- The ECAPA weights file. `poddrill fetch-weights` downloads `voxceleb_ECAPA512.onnx` from the pinned WeSpeaker commit, checks its size and SHA-256, and writes `~/.cache/poddrill/ecapa/voxceleb_ECAPA512.onnx`. `PODDRILL_EMBED_WEIGHTS` selects another path. WeSpeaker ECAPA-TDNN512 pretrained on VoxCeleb. VoxCeleb is used under CC BY 4.0.

`poddrill client doctor` prints a `fix` command for every check that is not ok. `poddrill bootstrap` runs `install-python`, `fetch-weights`, and `setup`.

Without `PODDRILL_WORKSPACE`, every command uses `~/poddrill`. `poddrill stop` stops the running owner.

Grok Bot cannot write its server entry. It prints the custom server to add: the absolute Node binary, `dist/cli.js`, and an env block. Add that server in the Grok Bot chat.

## Tests

`npm test` runs the unit tests. Those tests use `node --experimental-strip-types`.

`npm run test:smoke` runs a clean-home install, downloads the ECAPA file, and transcribes a short generated clip through `dist/cli.js`. It needs `python3` with `ensurepip`, `ffmpeg`, and `espeak-ng`. If one of those is missing, the test skips and names the missing tool. GitHub does not run these tests. Run `npm run test:smoke` on a computer that has those tools. Build `dist/` with `npm run build` first.

## Publish

Push a tag named `v` plus the version in `package.json`. `.github/workflows/publish.yml` publishes that commit to npm. The tag `v0.2.1` publishes version `0.2.1` and no other tag does.

npmjs.com must list a GitHub Actions trusted publisher for user `JeromeZhao`, repository `PodDrill`, and workflow filename `publish.yml`, with direct `npm publish` allowed. Save that publisher before the first tag. The first publish from GitHub has to succeed within two days of saving it, or npm expires the publisher.

## License

MIT License. Copyright 2026 Jianyu Zhao.

The ECAPA weights are separate from this license. WeSpeaker ECAPA-TDNN512 pretrained on VoxCeleb. VoxCeleb is used under CC BY 4.0.
