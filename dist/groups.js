/**
 * Speaker groups over stretch vectors. The cut is the widest gap in the
 * average-linkage cosines, not a fixed threshold.
 */
import { asRecord } from "./disk.js";
const UNGROUPED = "ungrouped";
const TIME = /^(\d{2}):(\d{2}):(\d{2})\.(\d{3}) --> (\d{2}):(\d{2}):(\d{2})\.(\d{3})$/;
export function readVttCues(vtt) {
    const cues = [];
    for (const block of vtt.replaceAll("\r\n", "\n").split("\n\n")) {
        const lines = block.split("\n").filter((line) => line.length > 0);
        const timeIndex = lines.findIndex((line) => TIME.test(line));
        if (timeIndex <= 0) {
            continue;
        }
        const id = lines[timeIndex - 1];
        const stamp = lines[timeIndex];
        if (id === undefined || stamp === undefined) {
            continue;
        }
        const match = TIME.exec(stamp);
        if (match === null) {
            continue;
        }
        cues.push({
            id,
            startMs: stampMs(match[1], match[2], match[3], match[4]),
            endMs: stampMs(match[5], match[6], match[7], match[8]),
            text: lines.slice(timeIndex + 1).join("\n"),
        });
    }
    return cues;
}
export function readStretchVectors(value) {
    const record = asRecord(value);
    if (record === undefined || !Array.isArray(record["stretches"])) {
        return undefined;
    }
    const parsed = [];
    let width;
    for (const item of record["stretches"]) {
        const stretch = asRecord(item);
        if (stretch === undefined) {
            return undefined;
        }
        const startMs = stretch["startMs"];
        const endMs = stretch["endMs"];
        const vector = finiteVector(stretch["vector"]);
        if (typeof startMs !== "number" || typeof endMs !== "number" || vector === undefined) {
            return undefined;
        }
        if (width === undefined) {
            width = vector.length;
        }
        if (vector.length !== width) {
            return undefined;
        }
        parsed.push({ startMs, endMs, vector });
    }
    return parsed;
}
export function assignCues(cues, stretches) {
    const stretchOfCue = cues.map((cue) => stretchCovering(stretches, cue.startMs));
    const used = [];
    for (const index of stretchOfCue) {
        if (index !== undefined && !used.includes(index)) {
            used.push(index);
        }
    }
    const vectors = used.flatMap((index) => {
        const stretch = stretches[index];
        return stretch === undefined ? [] : [stretch.vector];
    });
    const groupOfStretch = new Map();
    const centroids = new Map();
    for (const cluster of clusterVectors(vectors)) {
        const original = cluster.flatMap((compact) => {
            const index = used[compact];
            return index === undefined ? [] : [index];
        });
        const memberCues = cues.filter((_, cueIndex) => {
            const stretchIndex = stretchOfCue[cueIndex];
            return stretchIndex !== undefined && original.includes(stretchIndex);
        });
        const first = memberCues[0];
        if (first === undefined) {
            continue;
        }
        const groupId = `g${first.id}`;
        for (const index of original) {
            groupOfStretch.set(index, groupId);
        }
        const memberVectors = original.flatMap((index) => {
            const stretch = stretches[index];
            return stretch === undefined ? [] : [stretch.vector];
        });
        centroids.set(groupId, meanVector(memberVectors));
    }
    return cues.map((cue, cueIndex) => {
        const stretchIndex = stretchOfCue[cueIndex];
        const groupId = stretchIndex === undefined ? undefined : groupOfStretch.get(stretchIndex);
        const vector = stretchIndex === undefined ? undefined : stretches[stretchIndex]?.vector;
        if (groupId === undefined || vector === undefined) {
            return { id: cue.id, groupId: UNGROUPED, nearestGroupId: null, nearestCosine: null };
        }
        return { id: cue.id, groupId, ...nearestGroup(vector, groupId, centroids) };
    });
}
export function cueRows(cues, assignments) {
    const byId = new Map(assignments.map((assignment) => [assignment.id, assignment]));
    return cues.map((cue) => {
        const assignment = byId.get(cue.id);
        if (assignment === undefined) {
            return {
                id: cue.id,
                startMs: cue.startMs,
                endMs: cue.endMs,
                text: cue.text,
                groupId: UNGROUPED,
                nearestGroupId: null,
                nearestCosine: null,
            };
        }
        return {
            id: cue.id,
            startMs: cue.startMs,
            endMs: cue.endMs,
            text: cue.text,
            groupId: assignment.groupId,
            nearestGroupId: assignment.nearestGroupId,
            nearestCosine: assignment.nearestCosine,
        };
    });
}
export function readAssignments(value) {
    const record = asRecord(value);
    if (record === undefined || !Array.isArray(record["cues"])) {
        return undefined;
    }
    const assignments = [];
    for (const item of record["cues"]) {
        const parsed = readAssignment(item);
        if (parsed === undefined) {
            return undefined;
        }
        assignments.push(parsed);
    }
    return assignments;
}
export function knownGroupIds(rows) {
    const ids = new Set([UNGROUPED]);
    for (const row of rows) {
        ids.add(row.groupId);
    }
    return ids;
}
export function pageCues(rows, knownGroups, limit, after, groupId) {
    if (groupId !== undefined && !knownGroups.has(groupId)) {
        return { kind: "unknown-group", groupId };
    }
    const filtered = groupId === undefined ? rows : rows.filter((row) => row.groupId === groupId);
    let start = 0;
    if (after !== undefined) {
        const index = filtered.findIndex((row) => row.id === after);
        if (index === -1) {
            return { kind: "unknown-cue", cueId: after };
        }
        start = index + 1;
    }
    return { kind: "page", cues: filtered.slice(start, start + limit) };
}
export function parseLabelUpdates(value) {
    if (!Array.isArray(value)) {
        return undefined;
    }
    const updates = [];
    for (const item of value) {
        const record = asRecord(item);
        if (record === undefined) {
            return undefined;
        }
        const groupId = record["groupId"];
        const label = record["label"];
        if (typeof groupId !== "string" || groupId === "" || typeof label !== "string") {
            return undefined;
        }
        if (parseLabel(label) === undefined) {
            return undefined;
        }
        updates.push({ groupId, label });
    }
    return updates;
}
export function readLabels(value) {
    const record = asRecord(value);
    if (record === undefined || !Array.isArray(record["groups"])) {
        return undefined;
    }
    return parseLabelUpdates(record["groups"]);
}
export function mergeLabels(current, updates) {
    const map = new Map();
    for (const label of current) {
        map.set(label.groupId, label.label);
    }
    for (const label of updates) {
        map.set(label.groupId, label.label);
    }
    return [...map.entries()]
        .sort((left, right) => compareText(left[0], right[0]))
        .map(([groupId, label]) => ({ groupId, label }));
}
/** Person names only. `quote` and `ending` are marks, and `undetermined` is not a name. */
export function hostNames(labels) {
    const names = [];
    for (const stored of labels) {
        const parsed = parseLabel(stored.label);
        if (parsed === undefined) {
            continue;
        }
        const name = personName(parsed);
        if (name !== undefined) {
            names.push(name);
        }
    }
    return names;
}
function personName(label) {
    switch (label.kind) {
        case "name":
            return label.name;
        case "undetermined":
        case "quote":
        case "ending":
            return undefined;
        default: {
            const leftover = label;
            throw new Error(`unexpected label ${JSON.stringify(leftover)}`);
        }
    }
}
function parseLabel(label) {
    if (label === "") {
        return undefined;
    }
    switch (label) {
        case "undetermined":
            return { kind: "undetermined" };
        case "quote":
            return { kind: "quote" };
        case "ending":
            return { kind: "ending" };
        default:
            return { kind: "name", name: label };
    }
}
function readAssignment(value) {
    const record = asRecord(value);
    if (record === undefined) {
        return undefined;
    }
    const id = record["id"];
    const groupId = record["groupId"];
    const nearestGroupId = readNullableString(record["nearestGroupId"]);
    const nearestCosine = readNullableNumber(record["nearestCosine"]);
    if (typeof id !== "string" || id === "" || typeof groupId !== "string" || groupId === "") {
        return undefined;
    }
    if (nearestGroupId === undefined || nearestCosine === undefined) {
        return undefined;
    }
    if ((nearestGroupId === null) !== (nearestCosine === null)) {
        return undefined;
    }
    if (nearestGroupId === null || nearestCosine === null) {
        return { id, groupId, nearestGroupId: null, nearestCosine: null };
    }
    return { id, groupId, nearestGroupId, nearestCosine };
}
function readNullableString(value) {
    if (value === null) {
        return null;
    }
    return typeof value === "string" && value !== "" ? value : undefined;
}
function readNullableNumber(value) {
    if (value === null) {
        return null;
    }
    return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
function finiteVector(value) {
    if (!Array.isArray(value) || value.length === 0) {
        return undefined;
    }
    const numbers = [];
    for (const item of value) {
        if (typeof item !== "number" || !Number.isFinite(item)) {
            return undefined;
        }
        numbers.push(item);
    }
    return numbers;
}
function stretchCovering(stretches, startMs) {
    for (let index = 0; index < stretches.length; index += 1) {
        const stretch = stretches[index];
        if (stretch !== undefined && startMs >= stretch.startMs && startMs < stretch.endMs) {
            return index;
        }
    }
    return undefined;
}
function clusterVectors(vectors) {
    if (vectors.length === 0) {
        return [];
    }
    const merges = averageLinkageMerges(vectors);
    const cutoff = highSide(merges);
    const kept = cutoff === undefined ? [] : merges.filter((merge) => merge.cosine >= cutoff);
    return components(vectors.length, kept);
}
function averageLinkageMerges(vectors) {
    let clusters = vectors.map((_, index) => ({
        members: [index],
    }));
    const merges = [];
    while (clusters.length > 1) {
        let bestI = 0;
        let bestJ = 1;
        let bestScore = Number.NEGATIVE_INFINITY;
        for (let i = 0; i < clusters.length; i += 1) {
            for (let j = i + 1; j < clusters.length; j += 1) {
                const left = clusters[i];
                const right = clusters[j];
                if (left === undefined || right === undefined) {
                    continue;
                }
                const score = averageCosine(left.members, right.members, vectors);
                if (score > bestScore) {
                    bestScore = score;
                    bestI = i;
                    bestJ = j;
                }
            }
        }
        const left = clusters[bestI];
        const right = clusters[bestJ];
        if (left === undefined || right === undefined) {
            break;
        }
        merges.push({ cosine: bestScore, left: left.members, right: right.members });
        const merged = { members: [...left.members, ...right.members] };
        const next = clusters.filter((_, index) => index !== bestI && index !== bestJ);
        next.push(merged);
        clusters = next;
    }
    return merges;
}
/**
 * The high side is that merge's own cosine. Rounding it to a tenth would drop a
 * merge that still sits above the gap. A lone merge has no low side to refuse.
 * Equal gaps keep the higher cut.
 */
function highSide(merges) {
    if (merges.length === 0) {
        return undefined;
    }
    const ordered = [...merges].sort((left, right) => right.cosine - left.cosine);
    const first = ordered[0];
    if (first === undefined) {
        return undefined;
    }
    if (ordered.length === 1) {
        return first.cosine;
    }
    let widest = -1;
    let high = first.cosine;
    for (let index = 0; index < ordered.length - 1; index += 1) {
        const current = ordered[index];
        const next = ordered[index + 1];
        if (current === undefined || next === undefined) {
            continue;
        }
        const gap = current.cosine - next.cosine;
        if (gap > widest) {
            widest = gap;
            high = current.cosine;
        }
    }
    return high;
}
function components(count, merges) {
    const parent = Array.from({ length: count }, (_, index) => index);
    const find = (index) => {
        let cursor = index;
        const seen = [];
        for (;;) {
            const next = parent[cursor];
            if (next === undefined || next === cursor) {
                for (const item of seen) {
                    parent[item] = cursor;
                }
                return cursor;
            }
            seen.push(cursor);
            cursor = next;
        }
    };
    for (const merge of merges) {
        const left = merge.left[0];
        const right = merge.right[0];
        if (left === undefined || right === undefined) {
            continue;
        }
        const leftRoot = find(left);
        const rightRoot = find(right);
        if (leftRoot !== rightRoot) {
            parent[rightRoot] = leftRoot;
        }
    }
    const grouped = new Map();
    for (let index = 0; index < count; index += 1) {
        const root = find(index);
        const members = grouped.get(root);
        if (members === undefined) {
            grouped.set(root, [index]);
        }
        else {
            members.push(index);
        }
    }
    return [...grouped.values()];
}
function averageCosine(left, right, vectors) {
    let total = 0;
    let count = 0;
    for (const leftIndex of left) {
        for (const rightIndex of right) {
            const leftVector = vectors[leftIndex];
            const rightVector = vectors[rightIndex];
            if (leftVector === undefined || rightVector === undefined) {
                continue;
            }
            total += cosine(leftVector, rightVector);
            count += 1;
        }
    }
    return count === 0 ? 0 : total / count;
}
function nearestGroup(vector, groupId, centroids) {
    let bestId;
    let bestScore = 0;
    for (const [otherId, centroid] of centroids) {
        if (otherId === groupId) {
            continue;
        }
        const score = cosine(vector, centroid);
        if (bestId === undefined || score > bestScore || (score === bestScore && otherId < bestId)) {
            bestId = otherId;
            bestScore = score;
        }
    }
    if (bestId === undefined) {
        return { nearestGroupId: null, nearestCosine: null };
    }
    return { nearestGroupId: bestId, nearestCosine: bestScore };
}
function meanVector(vectors) {
    const first = vectors[0];
    if (first === undefined || vectors.length === 0) {
        return [];
    }
    const sum = Array.from({ length: first.length }, () => 0);
    for (const vector of vectors) {
        for (let index = 0; index < sum.length; index += 1) {
            const current = sum[index];
            const value = vector[index];
            if (current !== undefined && value !== undefined) {
                sum[index] = current + value;
            }
        }
    }
    return sum.map((value) => value / vectors.length);
}
function cosine(left, right) {
    let dot = 0;
    let leftNorm = 0;
    let rightNorm = 0;
    const length = Math.min(left.length, right.length);
    for (let index = 0; index < length; index += 1) {
        const a = left[index];
        const b = right[index];
        if (a === undefined || b === undefined) {
            continue;
        }
        dot += a * b;
        leftNorm += a * a;
        rightNorm += b * b;
    }
    const denom = Math.sqrt(leftNorm) * Math.sqrt(rightNorm);
    return denom === 0 ? 0 : dot / denom;
}
function stampMs(hours, minutes, seconds, millis) {
    return Number(hours) * 3_600_000 + Number(minutes) * 60_000 + Number(seconds) * 1_000 + Number(millis);
}
function compareText(left, right) {
    if (left === right) {
        return 0;
    }
    return left < right ? -1 : 1;
}
