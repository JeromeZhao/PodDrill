/**
 * One long-lived Python process that answers one framed request at a time on stdin/stdout.
 * Frame: 8-byte big-endian body length, then UTF-8 JSON.
 * Shared request: { "wavPath": string }. A Whistle request also sends "language".
 * Replies: { "kind": "ready", ... } once, then per request
 *          { "kind": "result", "result": <value> } or { "kind": "error", "message": string }.
 * Wire types stay in this file. The fleet sees parsed results and reason strings.
 */

import { spawn } from "node:child_process";

import { asRecord } from "./disk.ts";
import type { WorkerEvents, WorkerLink } from "./fleet.ts";
import { pythonFromEnv } from "./python-env.ts";

const MAX_FRAME_BYTES = 64 * 1024 * 1024;
const STDERR_TAIL_BYTES = 8 * 1024;

export interface WorkerFrame {
  readonly wavPath: string;
}

/** What differs between python workers. Everything else is the shared link. */
export interface FramedWorker<R> {
  /** Names the worker in its own failure messages, for example `cactus-needle`. */
  readonly label: string;
  /** Arguments to the interpreter. A script built on `PYTHON_FRAMES`. */
  readonly args: readonly string[];
  /** Interpreter to spawn. Omitted uses `PODDRILL_PYTHON` or `python3`. */
  readonly command?: string;
  /** Replace a raw exit tail with a stable reason. Omitted keeps the tail. */
  explainExit?(tail: string): string;
  /** The reason to refuse a ready frame, or `undefined` to accept it. */
  checkReady(ready: Readonly<Record<string, unknown>>): Promise<string | undefined>;
  /** Throws on a malformed result, which fails only that request. */
  parseResult(value: unknown): R;
}

/**
 * Python that every worker script starts with. Defines `send`, `recv`, and `serve(handle)`.
 * Frames get a private copy of fd 1. Fd 1 itself points at stderr before any later import,
 * so Python prints and native library writes cannot interleave with frames.
 */
export const PYTHON_FRAMES = [
  "import json",
  "import os",
  "import struct",
  "import sys",
  "out = os.fdopen(os.dup(1), \"wb\")",
  "os.dup2(2, 1)",
  "sys.stdout = sys.stderr",
  "inp = sys.stdin.buffer",
  "def send(obj):",
  "    body = json.dumps(obj).encode(\"utf-8\")",
  "    out.write(struct.pack(\">Q\", len(body)) + body)",
  "    out.flush()",
  "def recv():",
  "    head = inp.read(8)",
  "    if len(head) < 8:",
  "        return None",
  "    (size,) = struct.unpack(\">Q\", head)",
  "    return json.loads(inp.read(size).decode(\"utf-8\"))",
  "def serve(handle):",
  "    while True:",
  "        message = recv()",
  "        if message is None:",
  "            break",
  "        try:",
  "            result = handle(message)",
  "        except Exception as error:",
  "            send({\"kind\": \"error\", \"message\": str(error)})",
  "            continue",
  "        send({\"kind\": \"result\", \"result\": result})",
].join("\n");

type WorkerReply<R> =
  | { readonly kind: "ready"; readonly frame: Readonly<Record<string, unknown>> }
  | { readonly kind: "result"; readonly result: R }
  | { readonly kind: "error"; readonly message: string };

/** `checking` is the gap between the ready frame and `checkReady` settling. */
type LinkState = "booting" | "checking" | "ready" | "exited";

interface PendingRequest<R> {
  readonly resolve: (result: R) => void;
  readonly reject: (error: Error) => void;
}

export function spawnFramedWorker<R, Q extends WorkerFrame = WorkerFrame>(
  worker: FramedWorker<R>,
  events: WorkerEvents,
): WorkerLink<R, Q> {
  const label = worker.label;
  const command = worker.command ?? pythonFromEnv(process.env);
  const child = spawn(command, [...worker.args], { stdio: ["pipe", "pipe", "pipe"] });
  let state: LinkState = "booting";
  let pending: PendingRequest<R> | undefined;
  let stdout = Buffer.alloc(0);
  let stderrTail = Buffer.alloc(0);

  const exitOnce = (reason: string): void => {
    if (state === "exited") {
      return;
    }
    state = "exited";
    events.exit(reason);
    const settled = pending;
    pending = undefined;
    settled?.reject(new Error(reason));
  };

  const fail = (reason: string): void => {
    child.kill("SIGKILL");
    exitOnce(reason);
  };

  const onReply = (reply: WorkerReply<R> | undefined): void => {
    if (reply === undefined) {
      fail(`${label} worker sent a malformed reply`);
      return;
    }
    switch (reply.kind) {
      case "ready":
        if (state !== "booting") {
          fail(`${label} worker sent ready twice`);
          return;
        }
        state = "checking";
        void worker.checkReady(reply.frame).then(
          (refusal) => {
            if (state !== "checking") {
              return;
            }
            if (refusal !== undefined) {
              fail(refusal);
              return;
            }
            state = "ready";
            events.ready();
          },
          (error: unknown) => {
            fail(error instanceof Error ? error.message : String(error));
          },
        );
        return;
      case "result":
      case "error": {
        const settled = pending;
        if (state !== "ready" || settled === undefined) {
          fail(`${label} worker replied without a request`);
          return;
        }
        pending = undefined;
        if (reply.kind === "result") {
          settled.resolve(reply.result);
        } else {
          settled.reject(new Error(reply.message));
        }
        return;
      }
      default: {
        const leftover: never = reply;
        fail(`unexpected ${label} reply ${JSON.stringify(leftover)}`);
      }
    }
  };

  child.stdout.on("data", (chunk: Buffer) => {
    const frames = takeFrames(Buffer.concat([stdout, chunk]));
    stdout = Buffer.from(frames.rest);
    for (const body of frames.bodies) {
      if (state === "exited") {
        return;
      }
      onReply(parseReply(body, worker));
    }
    if (frames.oversized) {
      fail(`${label} worker sent a frame over ${MAX_FRAME_BYTES} bytes`);
    }
  });
  child.stderr.on("data", (chunk: Buffer) => {
    const joined = Buffer.concat([stderrTail, chunk]);
    stderrTail = Buffer.from(joined.subarray(Math.max(0, joined.length - STDERR_TAIL_BYTES)));
  });
  // Writing to a worker that already died raises EPIPE here. The close event reports the death.
  child.stdin.on("error", () => {});
  child.on("error", (error: Error) => {
    exitOnce(error.message);
  });
  child.on("close", (code: number | null) => {
    const tail = stderrTail.toString("utf8").trim();
    const raw = tail === "" ? `${label} exited with code ${code === null ? "null" : String(code)}` : tail;
    exitOnce(worker.explainExit === undefined ? raw : worker.explainExit(raw));
  });

  return {
    request(frame: Q): Promise<R> {
      if (state !== "ready" || pending !== undefined) {
        return Promise.reject(new Error(`${label} worker is not ready for a request`));
      }
      return new Promise((resolve, reject) => {
        // A death mid-request reports this request's stderr, not chatter from earlier requests.
        stderrTail = Buffer.alloc(0);
        pending = { resolve, reject };
        child.stdin.write(encodeFrame(frame));
      });
    },
    close(): void {
      // An idle worker reads EOF and exits. A busy one finishes, hits EPIPE on write, and exits.
      child.stdin.end();
      child.stdout.destroy();
    },
  };
}

function encodeFrame(body: WorkerFrame): Buffer {
  const json = Buffer.from(JSON.stringify(body), "utf8");
  const header = Buffer.alloc(8);
  header.writeBigUInt64BE(BigInt(json.length));
  return Buffer.concat([header, json]);
}

/** Same shape as `takeMessages` in owner.ts. `oversized` means the stream is corrupt. */
function takeFrames(buffer: Buffer): {
  readonly bodies: readonly unknown[];
  readonly rest: Buffer;
  readonly oversized: boolean;
} {
  const bodies: unknown[] = [];
  let rest = buffer;
  while (rest.length >= 8) {
    const size = rest.readBigUInt64BE(0);
    if (size > BigInt(MAX_FRAME_BYTES)) {
      return { bodies, rest: Buffer.alloc(0), oversized: true };
    }
    const end = 8 + Number(size);
    if (rest.length < end) {
      break;
    }
    const text = rest.subarray(8, end).toString("utf8");
    rest = rest.subarray(end);
    try {
      bodies.push(JSON.parse(text));
    } catch {
      bodies.push(undefined);
    }
  }
  return { bodies, rest, oversized: false };
}

/** `result` goes through `parseResult`, so a malformed result is a per-request error, not a crash. */
function parseReply<R>(value: unknown, worker: FramedWorker<R>): WorkerReply<R> | undefined {
  const record = asRecord(value);
  if (record === undefined) {
    return undefined;
  }
  const kind = record["kind"];
  if (kind === "ready") {
    return { kind: "ready", frame: record };
  }
  if (kind === "error" && typeof record["message"] === "string") {
    return { kind: "error", message: record["message"] };
  }
  if (kind === "result") {
    try {
      return { kind: "result", result: worker.parseResult(record["result"]) };
    } catch (error) {
      return { kind: "error", message: error instanceof Error ? error.message : String(error) };
    }
  }
  return undefined;
}
