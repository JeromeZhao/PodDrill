/**
 * The embedding unit, not a speaker rule. Cues join while the silence between them is at most
 * `STRETCH_GAP_MS` and the joined span is at most `STRETCH_MAX_MS`. A joined span shorter than
 * `STRETCH_MIN_MS` is too short for a stable vector and is dropped.
 */
export const STRETCH_GAP_MS = 500;
export const STRETCH_MAX_MS = 14_000;
export const STRETCH_MIN_MS = 4_000;
/** Cue spans in file order, from the WebVTT that `projectSlices` renders. */
export function readCueSpans(vtt) {
    const spans = [];
    for (const line of vtt.split("\n")) {
        const match = /^(\d{2}):(\d{2}):(\d{2})\.(\d{3}) --> (\d{2}):(\d{2}):(\d{2})\.(\d{3})$/.exec(line);
        if (match === null) {
            continue;
        }
        const [, sh, sm, ss, sms, eh, em, es, ems] = match;
        spans.push({ startMs: stampMs(sh, sm, ss, sms), endMs: stampMs(eh, em, es, ems) });
    }
    return spans;
}
export function planStretches(cues) {
    const joined = [];
    let open;
    for (const cue of cues) {
        if (open !== undefined &&
            cue.startMs - open.endMs <= STRETCH_GAP_MS &&
            cue.endMs - open.startMs <= STRETCH_MAX_MS) {
            open = { startMs: open.startMs, endMs: Math.max(open.endMs, cue.endMs) };
            continue;
        }
        if (open !== undefined) {
            joined.push(open);
        }
        open = cue;
    }
    if (open !== undefined) {
        joined.push(open);
    }
    return joined
        .filter((span) => span.endMs - span.startMs >= STRETCH_MIN_MS)
        .map((span, index) => ({ index, startMs: span.startMs, endMs: span.endMs }));
}
function stampMs(hours, minutes, seconds, millis) {
    return Number(hours) * 3_600_000 + Number(minutes) * 60_000 + Number(seconds) * 1_000 + Number(millis);
}
