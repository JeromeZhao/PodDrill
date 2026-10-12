import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { WhistleResult } from "../src/episode.ts";
import { openFleet, type SpawnWorker, type WorkerEvents } from "../src/fleet.ts";
import type { WhistleQuery } from "../src/needle.ts";
import { openWhistleCall } from "../src/provider.ts";

interface FakeRequest {
  readonly wavPath: string;
  readonly resolve: (result: WhistleResult) => void;
  readonly reject: (error: Error) => void;
}

interface FakeWorker {
  readonly events: WorkerEvents;
  readonly requests: FakeRequest[];
  closed: boolean;
}

type Outcome =
  | { readonly kind: "pending" }
  | { readonly kind: "ok"; readonly text: string }
  | { readonly kind: "error"; readonly message: string };

interface Watched {
  outcome: Outcome;
}

function harness(): { readonly spawn: SpawnWorker<WhistleResult>; readonly workers: FakeWorker[] } {
  const workers: FakeWorker[] = [];
  const spawn: SpawnWorker<WhistleResult> = (events) => {
    const worker: FakeWorker = { events, requests: [], closed: false };
    workers.push(worker);
    return {
      request: (wavPath) =>
        new Promise((resolve, reject) => {
          worker.requests.push({ wavPath, resolve, reject });
        }),
      close: () => {
        worker.closed = true;
      },
    };
  };
  return { spawn, workers };
}

function at(workers: readonly FakeWorker[], index: number): FakeWorker {
  const worker = workers[index];
  if (worker === undefined) {
    throw new Error(`no worker ${index}`);
  }
  return worker;
}

function request(worker: FakeWorker, index: number): FakeRequest {
  const found = worker.requests[index];
  if (found === undefined) {
    throw new Error(`no request ${index}`);
  }
  return found;
}

function paths(worker: FakeWorker): readonly string[] {
  return worker.requests.map((entry) => entry.wavPath);
}

function slice(index: number): string {
  return `/slices/${index}.wav`;
}

function result(text: string): WhistleResult {
  return {
    kind: "speech",
    text,
    language: "en",
    ttftMs: 1,
    decodeTps: 1,
    words: [{ word: text, start: 0.1, end: 0.4, probability: 0.9 }],
  };
}

function watch(promise: Promise<WhistleResult>): Watched {
  const watched: Watched = { outcome: { kind: "pending" } };
  promise.then(
    (value) => {
      watched.outcome = { kind: "ok", text: value.text };
    },
    (error: unknown) => {
      watched.outcome = { kind: "error", message: error instanceof Error ? error.message : String(error) };
    },
  );
  return watched;
}

function flush(): Promise<void> {
  return new Promise((resolve) => {
    setImmediate(resolve);
  });
}

describe("openFleet", () => {
  it("spawns nothing at open, waits for ready, and keeps the idle worker until close", async () => {
    const { spawn, workers } = harness();
    const fleet = openFleet({ limit: 3, spawn, closedMessage: "whistle host is closed" });
    await flush();
    assert.equal(workers.length, 0);

    const first = watch(fleet.run(slice(0)));
    assert.equal(workers.length, 1);
    const w0 = at(workers, 0);
    assert.deepEqual(paths(w0), []);
    w0.events.ready();
    assert.deepEqual(paths(w0), ["/slices/0.wav"]);
    request(w0, 0).resolve(result("zero"));
    await flush();
    assert.deepEqual(first.outcome, { kind: "ok", text: "zero" });

    await flush();
    assert.equal(w0.closed, false);
    const second = watch(fleet.run(slice(1)));
    assert.equal(workers.length, 1);
    assert.deepEqual(paths(w0), ["/slices/0.wav", "/slices/1.wav"]);
    request(w0, 1).resolve(result("one"));
    await flush();
    assert.deepEqual(second.outcome, { kind: "ok", text: "one" });

    await fleet.close();
    assert.equal(w0.closed, true);
  });

  it("boots one worker at a time and grows only while every live worker is busy", async () => {
    const { spawn, workers } = harness();
    const fleet = openFleet({ limit: 3, spawn, closedMessage: "whistle host is closed" });
    const calls = [0, 1, 2].map((index) => watch(fleet.run(slice(index))));
    assert.equal(workers.length, 1);

    at(workers, 0).events.ready();
    assert.deepEqual(paths(at(workers, 0)), ["/slices/0.wav"]);
    assert.equal(workers.length, 2);
    await flush();
    assert.equal(workers.length, 2);

    at(workers, 1).events.ready();
    assert.deepEqual(paths(at(workers, 1)), ["/slices/1.wav"]);
    assert.equal(workers.length, 3);

    at(workers, 2).events.ready();
    assert.deepEqual(paths(at(workers, 2)), ["/slices/2.wav"]);

    const fourth = watch(fleet.run(slice(3)));
    assert.equal(workers.length, 3);
    request(at(workers, 1), 0).resolve(result("one"));
    await flush();
    assert.deepEqual(paths(at(workers, 1)), ["/slices/1.wav", "/slices/3.wav"]);
    assert.deepEqual(calls[1]?.outcome, { kind: "ok", text: "one" });
    assert.deepEqual(fourth.outcome, { kind: "pending" });
    await fleet.close();
  });

  it("never runs more live workers than the limit and serves waiting slices in order", async () => {
    const { spawn, workers } = harness();
    const fleet = openFleet({ limit: 2, spawn, closedMessage: "whistle host is closed" });
    const calls = [0, 1, 2, 3, 4].map((index) => watch(fleet.run(slice(index))));
    at(workers, 0).events.ready();
    at(workers, 1).events.ready();
    assert.equal(workers.length, 2);

    request(at(workers, 0), 0).resolve(result("0"));
    await flush();
    request(at(workers, 1), 0).resolve(result("1"));
    await flush();
    request(at(workers, 0), 1).resolve(result("2"));
    await flush();
    request(at(workers, 1), 1).resolve(result("3"));
    await flush();
    request(at(workers, 0), 2).resolve(result("4"));
    await flush();

    assert.equal(workers.length, 2);
    assert.deepEqual(paths(at(workers, 0)), ["/slices/0.wav", "/slices/2.wav", "/slices/4.wav"]);
    assert.deepEqual(paths(at(workers, 1)), ["/slices/1.wav", "/slices/3.wav"]);
    assert.deepEqual(
      calls.map((call) => call.outcome),
      ["0", "1", "2", "3", "4"].map((text) => ({ kind: "ok", text })),
    );
    await fleet.close();
  });

  it("fails only the oldest waiting slice when a worker dies booting, then grows a replacement", async () => {
    const { spawn, workers } = harness();
    const fleet = openFleet({ limit: 2, spawn, closedMessage: "whistle host is closed" });
    const first = watch(fleet.run(slice(0)));
    const second = watch(fleet.run(slice(1)));
    assert.equal(workers.length, 1);

    at(workers, 0).events.exit("python3: command not found");
    await flush();
    assert.deepEqual(first.outcome, { kind: "error", message: "python3: command not found" });
    assert.deepEqual(second.outcome, { kind: "pending" });
    assert.equal(workers.length, 2);

    at(workers, 1).events.ready();
    assert.deepEqual(paths(at(workers, 1)), ["/slices/1.wav"]);
    request(at(workers, 1), 0).resolve(result("one"));
    await flush();
    assert.deepEqual(second.outcome, { kind: "ok", text: "one" });
    await fleet.close();
  });

  it("fails only the busy slice when a worker dies mid-request, then grows a replacement", async () => {
    const { spawn, workers } = harness();
    const fleet = openFleet({ limit: 1, spawn, closedMessage: "whistle host is closed" });
    const first = watch(fleet.run(slice(0)));
    const second = watch(fleet.run(slice(1)));
    const w0 = at(workers, 0);
    w0.events.ready();
    assert.deepEqual(paths(w0), ["/slices/0.wav"]);
    assert.equal(workers.length, 1);

    w0.events.exit("cactus-needle exited with code 139");
    request(w0, 0).reject(new Error("cactus-needle exited with code 139"));
    await flush();
    assert.deepEqual(first.outcome, { kind: "error", message: "cactus-needle exited with code 139" });
    assert.deepEqual(second.outcome, { kind: "pending" });
    assert.equal(workers.length, 2);

    at(workers, 1).events.ready();
    assert.deepEqual(paths(at(workers, 1)), ["/slices/1.wav"]);
    request(at(workers, 1), 0).resolve(result("one"));
    await flush();
    assert.deepEqual(second.outcome, { kind: "ok", text: "one" });
    await fleet.close();
  });

  it("keeps a worker whose request failed without exiting", async () => {
    const { spawn, workers } = harness();
    const fleet = openFleet({ limit: 2, spawn, closedMessage: "whistle host is closed" });
    const first = watch(fleet.run(slice(0)));
    const w0 = at(workers, 0);
    w0.events.ready();
    request(w0, 0).reject(new Error("bad wav header"));
    await flush();
    assert.deepEqual(first.outcome, { kind: "error", message: "bad wav header" });

    const second = watch(fleet.run(slice(1)));
    assert.equal(workers.length, 1);
    assert.deepEqual(paths(w0), ["/slices/0.wav", "/slices/1.wav"]);
    request(w0, 1).resolve(result("one"));
    await flush();
    assert.deepEqual(second.outcome, { kind: "ok", text: "one" });
    await fleet.close();
  });

  it("rejects waiting slices on close, closes every link, and ignores a second close", async () => {
    const { spawn, workers } = harness();
    const fleet = openFleet({ limit: 2, spawn, closedMessage: "whistle host is closed" });
    const calls = [0, 1, 2].map((index) => watch(fleet.run(slice(index))));
    at(workers, 0).events.ready();
    assert.equal(workers.length, 2);

    await fleet.close();
    await flush();
    assert.deepEqual(
      calls.map((call) => call.outcome),
      [
        { kind: "pending" },
        { kind: "error", message: "whistle host is closed" },
        { kind: "error", message: "whistle host is closed" },
      ],
    );
    assert.deepEqual(
      workers.map((worker) => worker.closed),
      [true, true],
    );

    at(workers, 1).events.ready();
    assert.deepEqual(paths(at(workers, 1)), []);
    await fleet.close();
    const late = watch(fleet.run(slice(3)));
    await flush();
    assert.deepEqual(late.outcome, { kind: "error", message: "whistle host is closed" });
    assert.equal(workers.length, 2);
  });

  it("drops idle workers and grows a new one for the next slice", async () => {
    const { spawn, workers } = harness();
    const fleet = openFleet({ limit: 2, spawn, closedMessage: "whistle host is closed" });
    const calls = [0, 1].map((index) => watch(fleet.run(slice(index))));
    at(workers, 0).events.ready();
    at(workers, 1).events.ready();
    request(at(workers, 0), 0).resolve(result("zero"));
    request(at(workers, 1), 0).resolve(result("one"));
    await flush();
    assert.deepEqual(
      calls.map((call) => call.outcome),
      [
        { kind: "ok", text: "zero" },
        { kind: "ok", text: "one" },
      ],
    );

    assert.equal(fleet.release(), true);
    assert.deepEqual(
      workers.map((worker) => worker.closed),
      [true, true],
    );

    const next = watch(fleet.run(slice(2)));
    assert.equal(workers.length, 3);
    const spawned = at(workers, 2);
    assert.equal(spawned.closed, false);
    spawned.events.ready();
    assert.deepEqual(paths(at(workers, 0)), ["/slices/0.wav"]);
    assert.deepEqual(paths(at(workers, 1)), ["/slices/1.wav"]);
    assert.deepEqual(paths(spawned), ["/slices/2.wav"]);
    request(spawned, 0).resolve(result("two"));
    await flush();
    assert.deepEqual(next.outcome, { kind: "ok", text: "two" });
    await fleet.close();
  });

  it("refuses to release while a worker is busy", async () => {
    const { spawn, workers } = harness();
    const fleet = openFleet({ limit: 1, spawn, closedMessage: "whistle host is closed" });
    const first = watch(fleet.run(slice(0)));
    const worker = at(workers, 0);
    worker.events.ready();
    assert.equal(fleet.release(), false);
    assert.equal(worker.closed, false);

    const second = watch(fleet.run(slice(1)));
    await flush();
    assert.deepEqual(second.outcome, { kind: "pending" });
    request(worker, 0).resolve(result("zero"));
    await flush();
    assert.deepEqual(first.outcome, { kind: "ok", text: "zero" });
    assert.equal(workers.length, 1);
    assert.deepEqual(paths(worker), ["/slices/0.wav", "/slices/1.wav"]);
    await fleet.close();
  });

  it("refuses to release after close", async () => {
    const { spawn, workers } = harness();
    const fleet = openFleet({ limit: 1, spawn, closedMessage: "whistle host is closed" });
    const first = watch(fleet.run(slice(0)));
    at(workers, 0).events.ready();
    request(at(workers, 0), 0).resolve(result("zero"));
    await flush();
    assert.deepEqual(first.outcome, { kind: "ok", text: "zero" });
    await fleet.close();
    assert.equal(at(workers, 0).closed, true);
    assert.equal(fleet.release(), false);
    const late = watch(fleet.run(slice(1)));
    await flush();
    assert.deepEqual(late.outcome, { kind: "error", message: "whistle host is closed" });
    assert.equal(workers.length, 1);
  });
});

describe("model pools", () => {
  it("keeps an English slice and a Japanese slice off the same worker", async () => {
    const workers: Array<{
      readonly events: WorkerEvents;
      readonly requests: Array<{ readonly wavPath: string; readonly language: string }>;
    }> = [];
    const spawn: SpawnWorker<WhistleResult, WhistleQuery> = (events) => {
      const requests: Array<{ readonly wavPath: string; readonly language: string }> = [];
      workers.push({ events, requests });
      return {
        request: (query) =>
          new Promise(() => {
            requests.push({ wavPath: query.wavPath, language: query.language });
          }),
        close: () => {},
      };
    };
    const host = openWhistleCall(
      "localhost",
      { fleetLimit: 1, modelFleet: {}, modelWeights: {} },
      spawn,
    );
    await flush();
    assert.equal(workers.length, 0);

    const english = watch(
      host.transcribeSlice({ sliceIndex: 0, startMs: 0, wavPath: "/en.wav", language: "en" }),
    );
    assert.equal(workers.length, 1);
    const worker = workers[0];
    if (worker === undefined) {
      throw new Error("no worker");
    }
    worker.events.ready();
    await flush();
    assert.deepEqual(english.outcome, { kind: "pending" });
    assert.deepEqual(worker.requests, [{ wavPath: "/en.wav", language: "en" }]);

    const japanese = watch(
      host.transcribeSlice({ sliceIndex: 0, startMs: 0, wavPath: "/ja.wav", language: "ja" }),
    );
    await flush();
    assert.equal(workers.length, 1);
    assert.deepEqual(worker.requests, [{ wavPath: "/en.wav", language: "en" }]);
    assert.deepEqual(japanese.outcome, {
      kind: "error",
      message: "moonshine-tiny-ja has no weights path",
    });
    await host.close();
  });

  it("keeps a Moonshine slice off the Whistle worker", async () => {
    const workers: Array<{ readonly requests: Array<{ readonly language: string }> }> = [];
    const spawn: SpawnWorker<WhistleResult, WhistleQuery> = () => {
      const requests: Array<{ readonly language: string }> = [];
      workers.push({ requests });
      return {
        request: (query) =>
          new Promise(() => {
            requests.push({ language: query.language });
          }),
        close: () => {},
      };
    };
    const host = openWhistleCall(
      "localhost",
      { fleetLimit: 1, modelFleet: {}, modelWeights: { "moonshine-tiny-ja": "/tmp/moonshine-ja" } },
      spawn,
      () => (events) => {
        setImmediate(() => {
          events.ready();
        });
        return {
          request: () =>
            Promise.reject(new Error("ModuleNotFoundError: No module named 'moonshine_voice'")),
          close: () => {},
        };
      },
    );
    const japanese = watch(
      host.transcribeSlice({ sliceIndex: 0, startMs: 0, wavPath: "/ja.wav", language: "ja" }),
    );
    await flush();
    assert.equal(workers.length, 0);
    assert.deepEqual(japanese.outcome, { kind: "error", message: "pip install moonshine-voice" });
    const english = watch(
      host.transcribeSlice({ sliceIndex: 0, startMs: 0, wavPath: "/en.wav", language: "en" }),
    );
    await flush();
    assert.equal(workers.length, 1);
    assert.deepEqual(english.outcome, { kind: "pending" });
    await host.close();
  });
});
