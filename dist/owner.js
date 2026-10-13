import { createHash } from "node:crypto";
import { createServer, createConnection } from "node:net";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendAudit, auditRecord, readAudit } from "./audit.js";
import { errorCode } from "./disk.js";
import { IDLE_FLEET_MS, watchIdleFleet } from "./idle-fleet.js";
import { embedWeightsPath, openEmbedHost } from "./embed.js";
import { readPackageIdentity } from "./package-identity.js";
import { JobQueue } from "./jobs.js";
import { openWhistleCall } from "./provider.js";
import { resolvePython } from "./python-env.js";
import { readConfig } from "./workspace.js";
export async function pythonForOwner(env, root) {
    const config = await readConfig(root);
    return resolvePython(env, config.python);
}
/**
 * macOS rejects a unix socket path longer than 104 bytes.
 * A workspace under /var/folders exceeds that, so the socket lives in the temp dir.
 */
export function socketPath(root) {
    const digest = createHash("sha256").update(root).digest("hex").slice(0, 16);
    return join(tmpdir(), `pw-${digest}.sock`);
}
export function render(value) {
    return `${JSON.stringify(value)}\n`;
}
export function callOwner(root, request) {
    return new Promise((resolve, reject) => {
        const socket = createConnection(socketPath(root));
        const chunks = [];
        socket.setTimeout(10_000);
        socket.on("data", (chunk) => {
            chunks.push(chunk);
        });
        socket.on("timeout", () => {
            socket.destroy(new Error("poddrill serve timed out"));
        });
        socket.on("error", reject);
        socket.on("end", () => {
            resolve(Buffer.concat(chunks).toString("utf8"));
        });
        socket.write(`${JSON.stringify(request)}\n`);
    });
}
export async function ownerAlive(root) {
    try {
        const text = await callOwner(root, { op: "ping" });
        return text === "{\"op\":\"pong\"}\n";
    }
    catch {
        return false;
    }
}
export async function serve(root, mcpOnStdio) {
    const sock = socketPath(root);
    const waiting = [];
    let queue;
    let requestStop = () => { };
    // allowHalfOpen so a client FIN cannot drop the reply while start is still reading audio.
    const server = createServer({ allowHalfOpen: true }, (connection) => {
        const opened = queue;
        if (opened === undefined) {
            // Answer after the queue opens. A refused connect would let another owner unlink this socket.
            connection.pause();
            waiting.push(connection);
            return;
        }
        accept(connection, opened, root, requestStop);
    });
    let claimed = false;
    try {
        claimed = await takeSocket(server, root);
    }
    catch (error) {
        await closeIdle(server);
        throw error;
    }
    if (!claimed) {
        await closeIdle(server);
        return;
    }
    const config = await readConfig(root);
    const python = await pythonForOwner(process.env, root);
    process.env["PODDRILL_PYTHON"] = python;
    const hosts = {
        whistle: openWhistleCall(config.provider, {
            fleetLimit: config.fleetLimit,
            modelFleet: config.modelFleet,
            modelWeights: config.modelWeights,
        }),
        embed: openEmbedHost(config.embeddingLimit, embedWeightsPath(process.env)),
    };
    let opened;
    try {
        opened = await JobQueue.open(root, config, hosts);
    }
    catch (error) {
        await closeHosts(hosts);
        throw error;
    }
    queue = opened;
    const watchers = [
        watchIdleFleet({
            idle: () => opened.idle("transcript"),
            release: () => hosts.whistle.release(),
            delayMs: IDLE_FLEET_MS,
            pollMs: 1_000,
        }),
        watchIdleFleet({
            idle: () => opened.idle("embedding"),
            release: () => hosts.embed.release(),
            delayMs: IDLE_FLEET_MS,
            pollMs: 1_000,
        }),
    ];
    const stopIdle = () => {
        for (const watcher of watchers) {
            watcher.stop();
        }
    };
    const gate = bindStop(server, sock, opened, hosts, stopIdle);
    requestStop = gate.stop;
    for (const connection of waiting.splice(0, waiting.length)) {
        accept(connection, opened, root, requestStop);
    }
    const version = mcpOnStdio ? (await readPackageIdentity(import.meta.url)).version : undefined;
    if (version !== undefined) {
        void speakMcp(version, async (name, args) => callTool(opened, root, name, args)).then(() => {
            gate.stop();
        });
    }
    await gate.done;
}
export async function proxyMcp(root) {
    const identity = await readPackageIdentity(import.meta.url);
    return speakMcp(identity.version, async (name, args) => {
        if (name === "start" && typeof args["path"] === "string") {
            const language = args["language"];
            if (language !== undefined && typeof language !== "string") {
                return render({ kind: "error", message: "language must be a string" });
            }
            return callOwner(root, {
                op: "start",
                audioPath: args["path"],
                ...(typeof language === "string" ? { language } : {}),
            });
        }
        if (name === "episode" && typeof args["episodeId"] === "string") {
            return callOwner(root, { op: "episode", episodeId: args["episodeId"] });
        }
        if (name === "audit" && typeof args["episodeId"] === "string") {
            return callOwner(root, { op: "audit", episodeId: args["episodeId"] });
        }
        if (name === "cues" && typeof args["episodeId"] === "string") {
            const cues = cuesRequest(args["episodeId"], args);
            return cues === undefined
                ? render({ kind: "error", message: "invalid cues arguments" })
                : callOwner(root, cues);
        }
        if (name === "labelGroups" && typeof args["episodeId"] === "string") {
            return callOwner(root, { op: "labelGroups", episodeId: args["episodeId"], groups: args["groups"] });
        }
        const summary = summaryRequest(name, args);
        if (summary !== undefined) {
            return callOwner(root, summary);
        }
        return render({ kind: "error", message: `unknown tool ${name}` });
    });
}
function accept(socket, queue, root, requestStop) {
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
        buffer = `${buffer}${chunk}`;
        const newline = buffer.indexOf("\n");
        if (newline === -1) {
            return;
        }
        const line = buffer.slice(0, newline);
        buffer = "";
        void handleLine(line, queue, root)
            .then((response) => {
            socket.end(response.text, () => {
                if (response.stop) {
                    requestStop();
                }
            });
        })
            .catch((error) => {
            const message = error instanceof Error ? error.message : String(error);
            socket.end(render({ kind: "error", message }));
        });
    });
    socket.resume();
}
function answered(text, stop = false) {
    return { text, stop };
}
async function handleLine(line, queue, root) {
    let parsed;
    try {
        parsed = JSON.parse(line);
    }
    catch {
        return answered(render({ kind: "error", message: "malformed request" }));
    }
    const request = parseRequest(parsed);
    if (request === undefined) {
        return answered(render({ kind: "error", message: "unknown request" }));
    }
    switch (request.op) {
        case "ping":
            return answered("{\"op\":\"pong\"}\n");
        case "stop":
            return answered(render({ kind: "ready", state: "stopped" }), true);
        case "audit":
            return answered(render(await readAudit(root, request.episodeId)));
        case "start":
            return answered(await finish(root, request, () => queue.start(request.audioPath, request.language ?? "en")));
        case "episode":
            return answered(await finish(root, request, () => queue.episode(request.episodeId)));
        case "cues":
            return answered(await finish(root, request, () => queue.cues(request.episodeId, {
                ...(request.limit === undefined ? {} : { limit: request.limit }),
                ...(request.after === undefined ? {} : { after: request.after }),
                ...(request.groupId === undefined ? {} : { groupId: request.groupId }),
                ...(request.hosts === undefined ? {} : { hosts: request.hosts }),
            })));
        case "labelGroups":
            return answered(await finish(root, request, () => queue.labelGroups(request.episodeId, request.groups)));
        case "startSummary":
            return answered(await finish(root, request, () => queue.startSummary(request.episodeId)));
        case "setSummary":
            return answered(await finish(root, request, () => queue.setSummary(request.episodeId, request.summaryId, request.summary)));
        case "putParagraph":
            return answered(await finish(root, request, () => queue.putParagraph(request.episodeId, request.summaryId, request.body)));
        case "postParagraph":
            return answered(await finish(root, request, () => queue.postParagraph(request.episodeId, request.summaryId, request.body)));
        case "summary":
            return answered(await finish(root, request, () => queue.summary(request.episodeId, request.summaryId)));
        default: {
            const leftover = request;
            return answered(render({ kind: "error", message: `unexpected ${JSON.stringify(leftover)}` }));
        }
    }
}
async function finish(root, request, run) {
    let response;
    try {
        response = await run();
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        response = { kind: "error", message };
    }
    const text = render(response);
    try {
        const record = auditRecord(request, response, new Date().toISOString());
        const episodeId = record === undefined ? undefined : auditEpisodeId(request, response);
        if (record !== undefined && episodeId !== undefined) {
            await appendAudit(root, episodeId, record);
        }
    }
    catch {
        return text;
    }
    return text;
}
function auditEpisodeId(request, response) {
    switch (request.op) {
        case "ping":
        case "audit":
        case "stop":
            return undefined;
        case "start":
            return startedEpisodeId(response);
        case "episode":
        case "cues":
        case "labelGroups":
        case "startSummary":
        case "setSummary":
        case "putParagraph":
        case "postParagraph":
        case "summary":
            return request.episodeId;
        default: {
            const leftover = request;
            throw new Error(`unexpected ${JSON.stringify(leftover)}`);
        }
    }
}
function startedEpisodeId(response) {
    const record = asRecord(response);
    const episode = record === undefined ? undefined : asRecord(record["episode"]);
    const episodeId = episode === undefined ? undefined : episode["episodeId"];
    return typeof episodeId === "string" ? episodeId : undefined;
}
async function callTool(queue, root, name, args) {
    if (name === "audit" && typeof args["episodeId"] === "string") {
        return render(await readAudit(root, args["episodeId"]));
    }
    if (name === "start" && typeof args["path"] === "string") {
        const language = args["language"];
        if (language !== undefined && typeof language !== "string") {
            return render({ kind: "error", message: "language must be a string" });
        }
        const request = {
            op: "start",
            audioPath: args["path"],
            ...(typeof language === "string" ? { language } : {}),
        };
        return finish(root, request, () => queue.start(request.audioPath, request.language ?? "en"));
    }
    if (name === "episode" && typeof args["episodeId"] === "string") {
        const episodeId = args["episodeId"];
        return finish(root, { op: "episode", episodeId }, () => queue.episode(episodeId));
    }
    if (name === "cues" && typeof args["episodeId"] === "string") {
        const cues = cuesRequest(args["episodeId"], args);
        return cues === undefined
            ? render({ kind: "error", message: "invalid cues arguments" })
            : finish(root, cues, () => queue.cues(cues.episodeId, {
                ...(cues.limit === undefined ? {} : { limit: cues.limit }),
                ...(cues.after === undefined ? {} : { after: cues.after }),
                ...(cues.groupId === undefined ? {} : { groupId: cues.groupId }),
                ...(cues.hosts === undefined ? {} : { hosts: cues.hosts }),
            }));
    }
    if (name === "labelGroups" && typeof args["episodeId"] === "string") {
        const episodeId = args["episodeId"];
        const groups = args["groups"];
        return finish(root, { op: "labelGroups", episodeId, groups }, () => queue.labelGroups(episodeId, groups));
    }
    const summary = summaryRequest(name, args);
    if (summary !== undefined) {
        return finish(root, summary, () => runSummary(queue, summary));
    }
    return render({ kind: "error", message: `unknown tool ${name}` });
}
function runSummary(queue, request) {
    switch (request.op) {
        case "startSummary":
            return queue.startSummary(request.episodeId);
        case "setSummary":
            return queue.setSummary(request.episodeId, request.summaryId, request.summary);
        case "putParagraph":
            return queue.putParagraph(request.episodeId, request.summaryId, request.body);
        case "postParagraph":
            return queue.postParagraph(request.episodeId, request.summaryId, request.body);
        case "summary":
            return queue.summary(request.episodeId, request.summaryId);
        default: {
            const leftover = request;
            return Promise.reject(new Error(`unexpected ${JSON.stringify(leftover)}`));
        }
    }
}
function parseRequest(value) {
    const record = asRecord(value);
    if (record === undefined) {
        return undefined;
    }
    const op = record["op"];
    if (op === "ping") {
        return { op: "ping" };
    }
    if (op === "stop") {
        return { op: "stop" };
    }
    if (op === "start" && typeof record["audioPath"] === "string") {
        const language = record["language"];
        if (language !== undefined && typeof language !== "string") {
            return undefined;
        }
        return {
            op: "start",
            audioPath: record["audioPath"],
            ...(typeof language === "string" ? { language } : {}),
        };
    }
    if (op === "episode" && typeof record["episodeId"] === "string") {
        return { op: "episode", episodeId: record["episodeId"] };
    }
    if (op === "audit" && typeof record["episodeId"] === "string") {
        return { op: "audit", episodeId: record["episodeId"] };
    }
    if (op === "cues" && typeof record["episodeId"] === "string") {
        return cuesRequest(record["episodeId"], record);
    }
    if (op === "labelGroups" && typeof record["episodeId"] === "string") {
        return { op: "labelGroups", episodeId: record["episodeId"], groups: record["groups"] };
    }
    if (typeof op === "string") {
        return summaryRequest(op, record);
    }
    return undefined;
}
function summaryRequest(name, args) {
    const episodeId = args["episodeId"];
    if (typeof episodeId !== "string") {
        return undefined;
    }
    const summaryId = args["summaryId"];
    switch (name) {
        case "startSummary":
            return { op: "startSummary", episodeId };
        case "setSummary":
            return typeof summaryId === "string"
                ? { op: "setSummary", episodeId, summaryId, summary: args["summary"] }
                : undefined;
        case "putParagraph":
            return typeof summaryId === "string"
                ? { op: "putParagraph", episodeId, summaryId, body: toolBody(args) }
                : undefined;
        case "postParagraph":
            return typeof summaryId === "string"
                ? { op: "postParagraph", episodeId, summaryId, body: toolBody(args) }
                : undefined;
        case "summary":
            return typeof summaryId === "string" ? { op: "summary", episodeId, summaryId } : undefined;
        default:
            return undefined;
    }
}
function toolBody(args) {
    const body = {};
    for (const [key, value] of Object.entries(args)) {
        if (key === "episodeId" || key === "summaryId") {
            continue;
        }
        body[key] = value;
    }
    return body;
}
function cuesRequest(episodeId, args) {
    const limit = args["limit"];
    const after = args["after"];
    const groupId = args["groupId"];
    const hosts = args["hosts"];
    if (limit !== undefined && typeof limit !== "number") {
        return undefined;
    }
    if (after !== undefined && typeof after !== "string") {
        return undefined;
    }
    if (groupId !== undefined && typeof groupId !== "string") {
        return undefined;
    }
    if (hosts !== undefined && typeof hosts !== "boolean") {
        return undefined;
    }
    return {
        op: "cues",
        episodeId,
        ...(typeof limit === "number" ? { limit } : {}),
        ...(typeof after === "string" ? { after } : {}),
        ...(typeof groupId === "string" ? { groupId } : {}),
        ...(typeof hosts === "boolean" ? { hosts } : {}),
    };
}
async function takeSocket(server, root) {
    const sock = socketPath(root);
    try {
        await listen(server, sock);
        return true;
    }
    catch (error) {
        if (errorCode(error) !== "EADDRINUSE") {
            throw error;
        }
    }
    if (await ownerAlive(root)) {
        return false;
    }
    // A leftover socket file makes bind return EADDRINUSE after the listener is gone.
    await rm(sock, { force: true });
    try {
        await listen(server, sock);
        return true;
    }
    catch (error) {
        if (errorCode(error) === "EADDRINUSE") {
            return false;
        }
        throw error;
    }
}
function listen(server, sock) {
    return new Promise((resolve, reject) => {
        const fail = (error) => {
            reject(error);
        };
        server.once("error", fail);
        server.listen(sock, () => {
            server.off("error", fail);
            resolve();
        });
    });
}
function bindStop(server, sock, queue, hosts, stopIdle) {
    let stopping = false;
    let resolveDone = () => { };
    const done = new Promise((resolve) => {
        resolveDone = resolve;
    });
    const stop = () => {
        if (stopping) {
            return;
        }
        stopping = true;
        void closeOwner(server, sock, queue, hosts, stopIdle).then(() => {
            resolveDone();
        });
    };
    process.on("SIGTERM", stop);
    process.on("SIGINT", stop);
    return { done, stop };
}
/** Stop the idle watchers, then the queue, so no lane takes new work. Then the hosts, so worker pipes close before exit. */
async function closeOwner(server, sock, queue, hosts, stopIdle) {
    stopIdle();
    await queue.close();
    await closeHosts(hosts);
    await new Promise((resolve) => {
        server.close(() => {
            resolve();
        });
    });
    await rm(sock, { force: true });
    process.exit(0);
}
async function closeHosts(hosts) {
    await hosts.whistle.close();
    await hosts.embed.close();
}
function closeIdle(server) {
    // Node emits error on close when listen never succeeded, unless a callback is set.
    return new Promise((resolve) => {
        server.close(() => {
            resolve();
        });
    });
}
function speakMcp(version, callTool) {
    return new Promise((resolve) => {
        let buffer = Buffer.alloc(0);
        let chain = Promise.resolve();
        const onData = (chunk) => {
            buffer = Buffer.concat([buffer, chunk]);
            const messages = takeMessages(buffer);
            buffer = messages.rest;
            for (const message of messages.bodies) {
                chain = chain.then(() => respond(message, callTool, version)).catch((error) => {
                    const messageText = error instanceof Error ? error.message : String(error);
                    process.stderr.write(`${messageText}\n`);
                });
            }
        };
        process.stdin.on("data", onData);
        process.stdin.on("end", () => {
            process.stdin.off("data", onData);
            resolve();
        });
        process.stdin.resume();
    });
}
function takeMessages(buffer) {
    const bodies = [];
    let rest = buffer;
    for (;;) {
        const headerEnd = rest.indexOf("\r\n\r\n");
        if (headerEnd === -1) {
            return { bodies, rest };
        }
        const header = rest.subarray(0, headerEnd).toString("utf8");
        const match = /Content-Length: (\d+)/i.exec(header);
        if (match === null) {
            return { bodies, rest: Buffer.alloc(0) };
        }
        const lengthText = match[1];
        if (lengthText === undefined) {
            return { bodies, rest: Buffer.alloc(0) };
        }
        const length = Number(lengthText);
        const start = headerEnd + 4;
        if (!Number.isInteger(length) || rest.length < start + length) {
            return { bodies, rest };
        }
        const body = rest.subarray(start, start + length).toString("utf8");
        rest = Buffer.from(rest.subarray(start + length));
        try {
            bodies.push(JSON.parse(body));
        }
        catch {
            bodies.push(undefined);
        }
    }
}
async function respond(message, callTool, version) {
    const record = asRecord(message);
    if (record === undefined || record["jsonrpc"] !== "2.0") {
        return;
    }
    const id = record["id"];
    const method = record["method"];
    if (typeof method !== "string" || (typeof id !== "number" && typeof id !== "string")) {
        return;
    }
    if (method === "initialize") {
        writeMessage({
            jsonrpc: "2.0",
            id,
            result: {
                protocolVersion: "2024-11-05",
                capabilities: { tools: {} },
                serverInfo: { name: "poddrill", version },
            },
        });
        return;
    }
    if (method === "tools/list") {
        writeMessage({
            jsonrpc: "2.0",
            id,
            result: { tools: toolList() },
        });
        return;
    }
    if (method === "tools/call") {
        const params = asRecord(record["params"]);
        const name = params === undefined ? undefined : params["name"];
        const args = params === undefined ? undefined : asRecord(params["arguments"]);
        const text = typeof name === "string"
            ? await callTool(name, args ?? {})
            : render({ kind: "error", message: "missing tool name" });
        writeMessage({
            jsonrpc: "2.0",
            id,
            result: {
                content: [{ type: "text", text }],
                isError: text.startsWith("{\"kind\":\"error\""),
            },
        });
    }
}
function toolList() {
    return [
        {
            name: "start",
            description: "Start an episode for one audio file under audio/.",
            inputSchema: {
                type: "object",
                properties: { path: { type: "string" }, language: { type: "string" } },
                required: ["path"],
                additionalProperties: false,
            },
        },
        {
            name: "episode",
            description: "Read one episode and its artifacts.",
            inputSchema: {
                type: "object",
                properties: { episodeId: { type: "string" } },
                required: ["episodeId"],
                additionalProperties: false,
            },
        },
        {
            name: "cues",
            description: "Read a page of transcript cues and their speaker groups.",
            inputSchema: {
                type: "object",
                properties: {
                    episodeId: { type: "string" },
                    limit: { type: "number" },
                    after: { type: "string" },
                    groupId: { type: "string" },
                    hosts: { type: "boolean" },
                },
                required: ["episodeId"],
                additionalProperties: false,
            },
        },
        {
            name: "labelGroups",
            description: "Replace labels on the listed speaker groups.",
            inputSchema: {
                type: "object",
                properties: {
                    episodeId: { type: "string" },
                    groups: { type: "array" },
                },
                required: ["episodeId", "groups"],
                additionalProperties: false,
            },
        },
        {
            name: "startSummary",
            description: "Start a summary for an episode and return a new id.",
            inputSchema: {
                type: "object",
                properties: {
                    episodeId: { type: "string" },
                },
                required: ["episodeId"],
                additionalProperties: false,
            },
        },
        {
            name: "setSummary",
            description: "Replace the summary text.",
            inputSchema: {
                type: "object",
                properties: {
                    episodeId: { type: "string" },
                    summaryId: { type: "string" },
                    summary: { type: "string" },
                },
                required: ["episodeId", "summaryId", "summary"],
                additionalProperties: false,
            },
        },
        {
            name: "putParagraph",
            description: "Replace one summary paragraph by index.",
            inputSchema: {
                type: "object",
                properties: {
                    episodeId: { type: "string" },
                    summaryId: { type: "string" },
                    index: { type: "number" },
                    text: { type: "string" },
                    cues: { type: "array", items: { type: "string" } },
                    startMs: { type: "number" },
                    endMs: { type: "number" },
                },
                required: ["episodeId", "summaryId", "index", "text", "cues"],
                additionalProperties: false,
            },
        },
        {
            name: "postParagraph",
            description: "Append one summary paragraph.",
            inputSchema: {
                type: "object",
                properties: {
                    episodeId: { type: "string" },
                    summaryId: { type: "string" },
                    text: { type: "string" },
                    cues: { type: "array", items: { type: "string" } },
                    startMs: { type: "number" },
                    endMs: { type: "number" },
                },
                required: ["episodeId", "summaryId", "text", "cues"],
                additionalProperties: false,
            },
        },
        {
            name: "summary",
            description: "Read one episode summary.",
            inputSchema: {
                type: "object",
                properties: {
                    episodeId: { type: "string" },
                    summaryId: { type: "string" },
                },
                required: ["episodeId", "summaryId"],
                additionalProperties: false,
            },
        },
        {
            name: "audit",
            description: "Read the episode audit trail.",
            inputSchema: {
                type: "object",
                properties: { episodeId: { type: "string" } },
                required: ["episodeId"],
                additionalProperties: false,
            },
        },
    ];
}
function writeMessage(message) {
    const body = Buffer.from(JSON.stringify(message), "utf8");
    const header = Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, "utf8");
    process.stdout.write(Buffer.concat([header, body]));
}
function asRecord(value) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return undefined;
    }
    return Object.fromEntries(Object.entries(value));
}
