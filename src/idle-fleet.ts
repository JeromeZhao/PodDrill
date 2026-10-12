export const IDLE_FLEET_MS = 10 * 60 * 1000;

export type IdlePhase = "busy" | "waiting" | "parked";

export interface IdleStep {
  readonly phase: IdlePhase;
  readonly arm: boolean;
  readonly disarm: boolean;
  readonly release: boolean;
}

export function stepIdle(phase: IdlePhase, idle: boolean, due: boolean): IdleStep {
  switch (phase) {
    case "busy":
      if (idle) {
        return { phase: "waiting", arm: true, disarm: false, release: false };
      }
      return { phase: "busy", arm: false, disarm: false, release: false };
    case "waiting":
      if (!idle) {
        return { phase: "busy", arm: false, disarm: true, release: false };
      }
      if (due) {
        return { phase: "parked", arm: false, disarm: true, release: true };
      }
      return { phase: "waiting", arm: false, disarm: false, release: false };
    case "parked":
      if (idle) {
        return { phase: "parked", arm: false, disarm: false, release: false };
      }
      return { phase: "busy", arm: false, disarm: false, release: false };
    default: {
      const leftover: never = phase;
      throw new Error(`unexpected idle phase ${String(leftover)}`);
    }
  }
}

export function watchIdleFleet(input: {
  readonly idle: () => boolean;
  readonly release: () => boolean;
  readonly delayMs: number;
  readonly pollMs: number;
}): { stop(): void } {
  // Empty at boot stays parked, so a queue that never started a worker does not release later.
  let phase: IdlePhase = input.idle() ? "parked" : "busy";
  let armed: ReturnType<typeof setTimeout> | undefined;

  const clearArmed = (): void => {
    if (armed === undefined) {
      return;
    }
    clearTimeout(armed);
    armed = undefined;
  };

  const arm = (): void => {
    clearArmed();
    armed = setTimeout(() => {
      armed = undefined;
      apply(input.idle(), true);
    }, input.delayMs);
  };

  const apply = (idle: boolean, due: boolean): void => {
    const step = stepIdle(phase, idle, due);
    if (step.disarm) {
      clearArmed();
    }
    if (step.release && !input.release()) {
      // The host still has work, so the wait starts over instead of parking.
      phase = "waiting";
      arm();
      return;
    }
    phase = step.phase;
    if (step.arm) {
      arm();
    }
  };

  const poll = setInterval(() => {
    apply(input.idle(), false);
  }, input.pollMs);

  return {
    stop(): void {
      clearInterval(poll);
      clearArmed();
    },
  };
}
