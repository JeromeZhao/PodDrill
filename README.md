# PodDrill

PodDrill transcribes episode audio into timed text, groups the voices, and stores a summary.

## Requirements

Use Node.js 22.18 or newer.

A transcript also needs ffmpeg and the Python package cactus-needle 3.2.0. That Python package is not the npm package named cactus-needle.

## Run

From this repository, run the command.

```
node src/cli.ts
```

`npm run build` writes `dist`. The published package runs `dist/cli.js`, because Node does not strip TypeScript inside `node_modules`.

The npm package is not published yet. After it is published, run `npx poddrill`.

## Workspace

Set `PODDRILL_WORKSPACE` to a directory outside this repository. Then run `poddrill setup` in that directory.

## License

MIT License. Copyright (c) 2026 Jianyu Zhao.
