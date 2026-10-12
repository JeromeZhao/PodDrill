import assert from "node:assert/strict";
import { describe, it, type TestContext } from "node:test";

import { stepIdle, watchIdleFleet, type IdlePhase, type IdleStep } from "../src/idle-fleet.ts";

const steps: readonly (readonly [IdlePhase, boolean, boolean, IdleStep])[] = [
  ["busy", false, false, { phase: "busy", arm: false, disarm: false, release: false }],
  ["busy", true, false, { phase: "waiting", arm: true, disarm: false, release: false }],
  ["waiting", false, false, { phase: "busy", arm: false, disarm: true, release: false }],
  ["waiting", true, false, { phase: "waiting", arm: false, disarm: false, release: false }],
  ["waiting", true, true, { phase: "parked", arm: false, disarm: true, release: true }],
  ["parked", true, false, { phase: "parked", arm: false, disarm: false, release: false }],
  ["parked", false, false, { phase: "busy", arm: false, disarm: false, release: false }],
];

interface Clock {
  idle: boolean;
  calls: number;
  allow: boolean;
}

function openWatch(t: TestContext, clock: Clock): { stop(): void } {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  return watchIdleFleet({
    idle: () => clock.idle,
    release: () => {
      clock.calls += 1;
      return clock.allow;
    },
    delayMs: 40,
    pollMs: 10,
  });
}

describe("stepIdle", () => {
  it("follows the idle phase table", () => {
    for (const [phase, idle, due, step] of steps) {
      assert.deepEqual(stepIdle(phase, idle, due), step, `${phase} idle=${String(idle)} due=${String(due)}`);
    }
  });
});

describe("watchIdleFleet", () => {
  it("does not release when the queue is already idle", (t: TestContext) => {
    const clock: Clock = { idle: true, calls: 0, allow: true };
    const watched = openWatch(t, clock);
    try {
      t.mock.timers.tick(80);
      assert.equal(clock.calls, 0);
    } finally {
      watched.stop();
      t.mock.timers.reset();
    }
  });

  it("releases once after the queue becomes idle", (t: TestContext) => {
    const clock: Clock = { idle: false, calls: 0, allow: true };
    const watched = openWatch(t, clock);
    try {
      clock.idle = true;
      t.mock.timers.tick(10);
      t.mock.timers.tick(40);
      assert.equal(clock.calls, 1);
      t.mock.timers.tick(80);
      assert.equal(clock.calls, 1);
    } finally {
      watched.stop();
      t.mock.timers.reset();
    }
  });

  it("does not release when the queue is busy again before the delay", (t: TestContext) => {
    const clock: Clock = { idle: false, calls: 0, allow: true };
    const watched = openWatch(t, clock);
    try {
      clock.idle = true;
      t.mock.timers.tick(10);
      clock.idle = false;
      t.mock.timers.tick(10);
      t.mock.timers.tick(80);
      assert.equal(clock.calls, 0);
    } finally {
      watched.stop();
      t.mock.timers.reset();
    }
  });

  it("does not release after stop", (t: TestContext) => {
    const clock: Clock = { idle: false, calls: 0, allow: true };
    const watched = openWatch(t, clock);
    try {
      clock.idle = true;
      t.mock.timers.tick(10);
      watched.stop();
      t.mock.timers.tick(80);
      assert.equal(clock.calls, 0);
    } finally {
      t.mock.timers.reset();
    }
  });

  it("releases again when the host refuses, then stops after a drop", (t: TestContext) => {
    const clock: Clock = { idle: false, calls: 0, allow: false };
    const watched = openWatch(t, clock);
    try {
      clock.idle = true;
      t.mock.timers.tick(10);
      t.mock.timers.tick(40);
      assert.equal(clock.calls, 1);
      clock.allow = true;
      t.mock.timers.tick(40);
      assert.equal(clock.calls, 2);
      t.mock.timers.tick(80);
      assert.equal(clock.calls, 2);
    } finally {
      watched.stop();
      t.mock.timers.reset();
    }
  });
});
