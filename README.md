# PodDrill

PodDrill is a skill that transcribes episode audio into timed text, groups the voices, and stores a summary.

## Say this

Copy this to the agent.

```text
Set up PodDrill on this computer.
```

The npm package is `poddrill`. The agent installs that package and the requirements below, then follows the skill shipped in the package.

## Requirements

The computer that runs PodDrill needs Node.js 22.18 or newer, `ffmpeg` on `PATH`, and the Python package `cactus-needle` 3.2.0. The npm package named cactus-needle is a different package.

That computer also needs the ECAPA weights file. The default path is `~/.cache/poddrill/ecapa/voxceleb_ECAPA512.onnx`. `PODDRILL_EMBED_WEIGHTS` selects another path.

Grok Bot cannot write its server entry. It prints the custom server to add. Add that server in the Grok Bot chat.

## License

MIT License. Copyright 2026 Jianyu Zhao.
