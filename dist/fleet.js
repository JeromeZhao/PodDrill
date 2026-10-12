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
/** Hosts pass their process spawner. Tests pass in-memory links. */
export function openFleet(options) {
    return new Fleet(options.limit, options.spawn, options.closedMessage);
}
/** Insertion order of `slots` is spawn order, so dispatch prefers the oldest idle worker. */
function nextMove(slots, waiting, limit) {
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
                const leftover = slot.state;
                throw new Error(`unexpected worker state ${String(leftover)}`);
            }
        }
    }
    if (booting || slots.size >= limit) {
        return { kind: "hold" };
    }
    return { kind: "grow" };
}
class Fleet {
    limit;
    spawn;
    closedMessage;
    /** Live workers only: booting, idle, or busy. */
    slots = new Map();
    /** FIFO. With one lane upstream this keeps today's request order. */
    waiting = [];
    nextId = 0;
    closed = false;
    constructor(limit, spawn, closedMessage) {
        this.limit = limit;
        this.spawn = spawn;
        this.closedMessage = closedMessage;
    }
    run(query) {
        if (this.closed) {
            return Promise.reject(new Error(this.closedMessage));
        }
        return new Promise((resolve, reject) => {
            this.waiting.push({ query, resolve, reject });
            this.pump();
        });
    }
    async close() {
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
    release() {
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
                    const leftover = slot.state;
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
    pump() {
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
                    void move.link.request(waiter.query).then((result) => {
                        this.onSettled(move.workerId);
                        waiter.resolve(result);
                    }, (error) => {
                        this.onSettled(move.workerId);
                        waiter.reject(error);
                    });
                    break;
                }
                default: {
                    const leftover = move;
                    throw new Error(`unexpected fleet move ${JSON.stringify(leftover)}`);
                }
            }
        }
    }
    onSettled(id) {
        const slot = this.slots.get(id);
        if (slot?.state === "busy") {
            this.slots.set(id, { state: "idle", link: slot.link });
        }
        this.pump();
    }
    onReady(id) {
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
    onExit(id, reason) {
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
