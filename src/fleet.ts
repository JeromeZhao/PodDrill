/**
 * A warm, demand-grown fleet of single-request workers behind one `run`.
 * Policy (high-water hold):
 * - Nothing spawns at open.
 * - Grow by one when a request is waiting and every live worker is busy, while live < limit.
 *   A booting worker is live and not busy, so at most one worker boots at a time.
 * - Idle workers stay until `release` or `close`.
 * - A dead worker is removed. It is replaced only by the grow rule above.
 * Dead is represented by absence from `slots`, so the live count is `slots.size`.
 */

/**
 * Callbacks a worker link fires. Never synchronously inside `spawn`.
 * `exit` fires exactly once, and nothing fires after it.
 */
export interface WorkerEvents {
  /** The worker loaded and accepted its ready frame. At most once, before any request. */
  ready(): void;
  /** The process is gone. `reason` is the message a request that depended on it fails with. */
  exit(reason: string): void;
}

/**
 * One warm process. The fleet sends at most one request at a time, and only after `ready`.
 * On death the link fires `exit` before it rejects the request in flight,
 * so the fleet never sees a dead worker as idle.
 */
export interface WorkerLink<R, Q = string> {
  /** Rejects with a per-request error (the worker stays up) or with the exit reason (the worker is gone). */
  request(query: Q): Promise<R>;
  /** End stdin. The process exits on EOF, after the request in flight if any. */
  close(): void;
}

export type SpawnWorker<R, Q = string> = (events: WorkerEvents) => WorkerLink<R, Q>;

/** Callers may overlap `run`. Overlap past the limit waits rather than spawns. */
export interface WorkerPool<R, Q = string> {
  run(query: Q): Promise<R>;
  /**
   * End every worker by closing its pipes, and reject requests that are still waiting.
   * Idempotent. Does not wait for a busy worker to finish its request.
   */
  close(): Promise<void>;
  /** Drop idle workers and leave the pool open. False means nothing changed. */
  release(): boolean;
}

/** Hosts pass their process spawner. Tests pass in-memory links. */
export function openFleet<R, Q = string>(options: {
  readonly limit: number;
  readonly spawn: SpawnWorker<R, Q>;
  readonly closedMessage: string;
}): WorkerPool<R, Q> {
  return new Fleet(options.limit, options.spawn, options.closedMessage);
}

interface Slot<R, Q> {
  readonly state: "booting" | "idle" | "busy";
  readonly link: WorkerLink<R, Q>;
}

interface Waiter<R, Q> {
  readonly query: Q;
  readonly resolve: (result: R) => void;
  readonly reject: (error: unknown) => void;
}

type FleetMove<R, Q> =
  | { readonly kind: "dispatch"; readonly workerId: number; readonly link: WorkerLink<R, Q> }
  | { readonly kind: "grow" }
  | { readonly kind: "hold" };

/** Insertion order of `slots` is spawn order, so dispatch prefers the oldest idle worker. */
function nextMove<R, Q>(
  slots: ReadonlyMap<number, Slot<R, Q>>,
  waiting: number,
  limit: number,
): FleetMove<R, Q> {
  if (waiting === 0) {
    return { kind: "hold" };
  }
  let booting = false;
  for (const [workerId, slot] of slots) {
    switch (slot.state) {
      case "idle":
        return { kind: "dispatch", workerId, link: slot.link };
      case "booting":
        booting = true;
        break;
      case "busy":
        break;
      default: {
        const leftover: never = slot.state;
        throw new Error(`unexpected worker state ${String(leftover)}`);
      }
    }
  }
  if (booting || slots.size >= limit) {
    return { kind: "hold" };
  }
  return { kind: "grow" };
}

class Fleet<R, Q> implements WorkerPool<R, Q> {
  private readonly limit: number;
  private readonly spawn: SpawnWorker<R, Q>;
  private readonly closedMessage: string;
  /** Live workers only: booting, idle, or busy. */
  private readonly slots = new Map<number, Slot<R, Q>>();
  /** FIFO. With one lane upstream this keeps today's request order. */
  private readonly waiting: Waiter<R, Q>[] = [];
  private nextId = 0;
  private closed = false;

  constructor(limit: number, spawn: SpawnWorker<R, Q>, closedMessage: string) {
    this.limit = limit;
    this.spawn = spawn;
    this.closedMessage = closedMessage;
  }

  run(query: Q): Promise<R> {
    if (this.closed) {
      return Promise.reject(new Error(this.closedMessage));
    }
    return new Promise((resolve, reject) => {
      this.waiting.push({ query, resolve, reject });
      this.pump();
    });
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    for (const waiter of this.waiting.splice(0)) {
      waiter.reject(new Error(this.closedMessage));
    }
    for (const slot of this.slots.values()) {
      slot.link.close();
    }
    this.slots.clear();
  }

  release(): boolean {
    if (this.closed || this.waiting.length > 0) {
      return false;
    }
    for (const slot of this.slots.values()) {
      switch (slot.state) {
        case "idle":
          break;
        case "booting":
        case "busy":
          return false;
        default: {
          const leftover: never = slot.state;
          throw new Error(`unexpected worker state ${String(leftover)}`);
        }
      }
    }
    for (const slot of this.slots.values()) {
      slot.link.close();
    }
    this.slots.clear();
    return true;
  }

  private pump(): void {
    while (!this.closed) {
      const move = nextMove(this.slots, this.waiting.length, this.limit);
      switch (move.kind) {
        case "hold":
          return;
        case "grow": {
          const id = this.nextId;
          this.nextId += 1;
          const link = this.spawn({
            ready: () => {
              this.onReady(id);
            },
            exit: (reason) => {
              this.onExit(id, reason);
            },
          });
          this.slots.set(id, { state: "booting", link });
          break;
        }
        case "dispatch": {
          const waiter = this.waiting.shift();
          if (waiter === undefined) {
            return;
          }
          this.slots.set(move.workerId, { state: "busy", link: move.link });
          // The worker goes idle before the caller sees the result, so an immediate next call reuses it.
          void move.link.request(waiter.query).then(
            (result) => {
              this.onSettled(move.workerId);
              waiter.resolve(result);
            },
            (error: unknown) => {
              this.onSettled(move.workerId);
              waiter.reject(error);
            },
          );
          break;
        }
        default: {
          const leftover: never = move;
          throw new Error(`unexpected fleet move ${JSON.stringify(leftover)}`);
        }
      }
    }
  }

  private onSettled(id: number): void {
    const slot = this.slots.get(id);
    if (slot?.state === "busy") {
      this.slots.set(id, { state: "idle", link: slot.link });
    }
    this.pump();
  }

  private onReady(id: number): void {
    const slot = this.slots.get(id);
    if (slot?.state !== "booting") {
      return;
    }
    this.slots.set(id, { state: "idle", link: slot.link });
    this.pump();
  }

  /**
   * A worker that died booting fails the oldest waiting request with its reason.
   * Load failures are deterministic (no python3, a missing module, weights that do not load),
   * and failing one request per failed boot bounds the respawn loop by the upstream window.
   * A worker that died busy fails only its own request, which the link rejects.
   */
  private onExit(id: number, reason: string): void {
    const slot = this.slots.get(id);
    if (slot === undefined) {
      return;
    }
    this.slots.delete(id);
    if (slot.state === "booting") {
      this.waiting.shift()?.reject(new Error(reason));
    }
    this.pump();
  }
}
