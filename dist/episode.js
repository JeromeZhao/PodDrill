/**
 * Episode clock, slice plan, and WebVTT projection.
 * Cue times are built only by adding a slice start to a Whistle word time.
 */
/** Milliseconds. Constructed only by `shift`. */
export class EpisodeTime {
    milliseconds;
    constructor(milliseconds) {
        this.milliseconds = milliseconds;
    }
    /**
     * The only way to build an episode time.
     * `sliceStartMs` is the slice offset. `wordSeconds` is Whistle's slice-relative clock.
     */
    static shift(sliceStartMs, wordSeconds) {
        if (!Number.isInteger(sliceStartMs) || sliceStartMs < 0) {
            throw new Error("slice start must be a non-negative integer millisecond");
        }
        if (!Number.isFinite(wordSeconds) || wordSeconds < 0) {
            throw new Error("word time must be a non-negative finite second");
        }
        return new EpisodeTime(sliceStartMs + Math.round(wordSeconds * 1000));
    }
}
/** 28 seconds, under Whistle's 30 second limit. */
export const SLICE_MS = 28000;
/** Overlap so a hard cut can drop the repeated word from the later slice. */
export const OVERLAP_MS = 1000;
/** A cue longer than this closes even when Whistle omitted punctuation. */
export const MAX_CUE_MS = 12000;
const STEP_MS = SLICE_MS - OVERLAP_MS;
/** Fixed grid. No silence detector. */
export function planSlices(durationMs) {
    if (!Number.isInteger(durationMs) || durationMs < 0) {
        throw new Error("duration must be a non-negative integer millisecond");
    }
    if (durationMs === 0) {
        return [];
    }
    const slices = [];
    let index = 0;
    for (let start = 0; start < durationMs; start += STEP_MS) {
        const end = Math.min(start + SLICE_MS, durationMs);
        const keepEnd = end === durationMs ? durationMs : start + STEP_MS;
        slices.push({
            index,
            startMs: start,
            endMs: end,
            keepStartMs: start,
            keepEndMs: keepEnd,
        });
        index += 1;
        if (end === durationMs) {
            break;
        }
    }
    return slices;
}
/**
 * Rebuild cues and WebVTT from slice records.
 * A rerun with the same records returns the same text.
 */
export function projectSlices(records) {
    const kept = [];
    const segments = [];
    for (const record of records) {
        const fates = [];
        if (record.whistle.kind === "speech") {
            record.whistle.words.forEach((word, wordIndex) => {
                const start = EpisodeTime.shift(record.plan.startMs, word.start);
                let end = EpisodeTime.shift(record.plan.startMs, word.end);
                if (end.milliseconds <= start.milliseconds) {
                    end = EpisodeTime.shift(record.plan.startMs, word.start + 0.001);
                }
                const inWindow = start.milliseconds >= record.plan.keepStartMs &&
                    start.milliseconds < record.plan.keepEndMs;
                if (inWindow) {
                    kept.push({
                        sliceIndex: record.plan.index,
                        wordIndex,
                        text: word.word,
                        start,
                        end,
                    });
                }
                fates.push({
                    wordIndex,
                    word: word.word,
                    episodeStart: start,
                    episodeEnd: end,
                    kept: inWindow,
                    cueId: undefined,
                });
            });
        }
        segments.push({
            sliceIndex: record.plan.index,
            slicePath: record.slicePath,
            startMs: record.plan.startMs,
            endMs: record.plan.endMs,
            whistle: record.whistle,
            words: fates,
        });
    }
    const cues = groupCues(kept);
    const withCueIds = assignCueIds(segments, cues);
    return {
        vtt: renderVtt(cues),
        cues,
        segments: withCueIds,
    };
}
function groupCues(words) {
    const cues = [];
    let bucket = [];
    const close = () => {
        if (bucket.length === 0) {
            return;
        }
        const first = bucket[0];
        const last = bucket[bucket.length - 1];
        if (first === undefined || last === undefined) {
            return;
        }
        cues.push({
            id: cueId(cues.length),
            start: first.start,
            end: last.end,
            text: bucket.map((word) => word.text).join(" "),
            pieces: bucket.map((word) => ({
                sliceIndex: word.sliceIndex,
                wordIndex: word.wordIndex,
            })),
        });
        bucket = [];
    };
    for (const word of words) {
        const first = bucket[0];
        if (first !== undefined &&
            word.start.milliseconds - first.start.milliseconds >= MAX_CUE_MS) {
            close();
        }
        bucket.push(word);
        // CJK lines end on 。！？. The ASCII class never sees them, so the cue would run on.
        if (/[.!?。！？]$/.test(word.text)) {
            close();
        }
    }
    close();
    return cues;
}
function cueId(index) {
    return `c${String(index + 1).padStart(4, "0")}`;
}
function assignCueIds(segments, cues) {
    const cueByPiece = new Map();
    for (const cue of cues) {
        for (const piece of cue.pieces) {
            cueByPiece.set(`${piece.sliceIndex}:${piece.wordIndex}`, cue.id);
        }
    }
    return segments.map((segment) => ({
        ...segment,
        words: segment.words.map((word) => ({
            ...word,
            cueId: cueByPiece.get(`${segment.sliceIndex}:${word.wordIndex}`),
        })),
    }));
}
function renderVtt(cues) {
    const blocks = cues.map((cue) => {
        return [
            cue.id,
            `${stamp(cue.start.milliseconds)} --> ${stamp(cue.end.milliseconds)}`,
            escapeCue(cue.text),
        ].join("\n");
    });
    return ["WEBVTT", ...blocks].join("\n\n").concat("\n");
}
function stamp(ms) {
    const hours = Math.floor(ms / 3_600_000);
    const minutes = Math.floor((ms % 3_600_000) / 60_000);
    const seconds = Math.floor((ms % 60_000) / 1_000);
    const millis = ms % 1_000;
    return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}.${String(millis).padStart(3, "0")}`;
}
function pad(value) {
    return String(value).padStart(2, "0");
}
function escapeCue(text) {
    return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}
function asRecord(value) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return undefined;
    }
    return Object.fromEntries(Object.entries(value));
}
function readString(record, key) {
    const value = record[key];
    if (typeof value !== "string") {
        throw new Error(`Whistle field ${key} must be a string`);
    }
    return value;
}
function readNumber(record, key) {
    const value = record[key];
    if (typeof value !== "number" || !Number.isFinite(value)) {
        throw new Error(`Whistle field ${key} must be a finite number`);
    }
    return value;
}
/** Parse one Whistle JSON object at the boundary. */
export function parseWhistle(value) {
    const record = asRecord(value);
    if (record === undefined) {
        throw new Error("Whistle result must be an object");
    }
    const text = readString(record, "text");
    const language = readString(record, "language");
    const ttftMs = readNumber(record, "ttft_ms");
    const decodeTps = readNumber(record, "decode_tps");
    const wordsValue = record["words"];
    if (text === "" && language === "" && !Array.isArray(wordsValue)) {
        return { kind: "silence", text: "", language: "", ttftMs, decodeTps };
    }
    if (!Array.isArray(wordsValue)) {
        throw new Error("Whistle speech result must include words");
    }
    const words = wordsValue.map((item) => {
        const word = asRecord(item);
        if (word === undefined) {
            throw new Error("Whistle word must be an object");
        }
        return {
            word: readString(word, "word"),
            start: readNumber(word, "start"),
            end: readNumber(word, "end"),
            probability: readNumber(word, "probability"),
        };
    });
    return { kind: "speech", text, language, ttftMs, decodeTps, words };
}
/** Inverse of `parseWhistle`. Writes Whistle's wire field names. */
export function serializeWhistle(result) {
    const wire = {
        text: result.text,
        language: result.language,
        ttft_ms: result.ttftMs,
        decode_tps: result.decodeTps,
    };
    if (result.kind === "silence") {
        return JSON.stringify(wire);
    }
    return JSON.stringify({
        ...wire,
        words: result.words.map(({ word, start, end, probability }) => ({ word, start, end, probability })),
    });
}
