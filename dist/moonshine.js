/**
 * The local Moonshine worker. One Python process constructs one `Transcriber`.
 * Ready frame: { "kind": "ready" }. Result: lines mapped onto `WhistleResult`.
 */
import { asRecord } from "./disk.js";
import { moonshineInstallLine } from "./python-env.js";
import { PYTHON_FRAMES, spawnFramedWorker } from "./worker.js";
const INSTALL_MESSAGE = moonshineInstallLine();
/** A missing `moonshine_voice` module becomes the install line. Any other text stays. */
export function moonshineFailureMessage(text) {
    if (text.includes("ModuleNotFoundError") && text.includes("moonshine_voice")) {
        return INSTALL_MESSAGE;
    }
    return text;
}
/**
 * Map one Moonshine transcript onto the Whistle result cue building already reads.
 * A line with text and no words becomes one word from `start_time` through `duration`.
 * No words at all is silence.
 */
export function moonshineToWhistle(value, language) {
    const record = asRecord(value);
    if (record === undefined) {
        throw new Error("Moonshine result must be an object");
    }
    const lines = record["lines"];
    if (!Array.isArray(lines)) {
        throw new Error("Moonshine result must include lines");
    }
    const words = [];
    const texts = [];
    for (const item of lines) {
        const line = readLine(item);
        if (line === undefined) {
            continue;
        }
        texts.push(line.text);
        words.push(...line.words);
    }
    if (words.length === 0) {
        return { kind: "silence", text: "", language: "", ttftMs: 0, decodeTps: 0 };
    }
    return {
        kind: "speech",
        text: texts.join(" "),
        language,
        ttftMs: 0,
        decodeTps: 0,
        words,
    };
}
export function spawnMoonshineWorker(model, weightsDir) {
    const arch = archInt(model.arch);
    return (events) => {
        const link = spawnFramedWorker({
            label: "moonshine",
            args: ["-c", MOONSHINE_SCRIPT, weightsDir, String(arch)],
            checkReady: async () => undefined,
            parseResult: (value) => moonshineToWhistle(value, model.language),
        }, {
            ready: () => {
                events.ready();
            },
            exit: (reason) => {
                events.exit(moonshineFailureMessage(reason));
            },
        });
        return {
            request: async (frame) => {
                try {
                    return await link.request(frame);
                }
                catch (error) {
                    const message = error instanceof Error ? error.message : String(error);
                    throw new Error(moonshineFailureMessage(message));
                }
            },
            close: () => {
                link.close();
            },
        };
    };
}
function archInt(arch) {
    switch (arch) {
        case "tiny":
            return 0;
        case "base":
            return 1;
        default: {
            const leftover = arch;
            throw new Error(`unexpected moonshine architecture ${String(leftover)}`);
        }
    }
}
function readLine(value) {
    const record = asRecord(value);
    if (record === undefined) {
        throw new Error("Moonshine line must be an object");
    }
    const text = readString(record, "text");
    const timed = readWords(record["words"]);
    if (timed.length > 0) {
        return { text: text === "" ? timed.map((word) => word.word).join(" ") : text, words: timed };
    }
    if (text === "") {
        return undefined;
    }
    const start = readSeconds(record, "start_time");
    const duration = readSeconds(record, "duration");
    return {
        text,
        words: [{ word: text, start, end: start + duration, probability: 1 }],
    };
}
function readWords(value) {
    if (value === undefined) {
        return [];
    }
    if (!Array.isArray(value)) {
        throw new Error("Moonshine words must be an array");
    }
    return value.map((item) => {
        const word = asRecord(item);
        if (word === undefined) {
            throw new Error("Moonshine word must be an object");
        }
        return {
            word: readString(word, "word"),
            start: readSeconds(word, "start"),
            end: readSeconds(word, "end"),
            probability: readFinite(word, "confidence"),
        };
    });
}
function readString(record, key) {
    const value = record[key];
    if (typeof value !== "string") {
        throw new Error(`Moonshine field ${key} must be a string`);
    }
    return value;
}
function readFinite(record, key) {
    const value = record[key];
    if (typeof value !== "number" || !Number.isFinite(value)) {
        throw new Error(`Moonshine field ${key} must be a finite number`);
    }
    return value;
}
function readSeconds(record, key) {
    const value = readFinite(record, key);
    if (value < 0) {
        throw new Error(`Moonshine field ${key} must be non-negative`);
    }
    return value;
}
const MOONSHINE_SCRIPT = [
    PYTHON_FRAMES,
    "import wave",
    "from moonshine_voice import Transcriber, ModelArch",
    "transcriber = Transcriber(",
    "    model_path=sys.argv[1],",
    "    model_arch=ModelArch(int(sys.argv[2])),",
    "    options={\"word_timestamps\": \"true\", \"max_tokens_per_second\": \"13.0\"},",
    ")",
    "def read_pcm(path):",
    "    with wave.open(path, \"rb\") as reader:",
    "        if reader.getnchannels() != 1 or reader.getsampwidth() != 2:",
    "            raise ValueError(f\"{path} is not 16-bit mono wav\")",
    "        pcm = reader.readframes(reader.getnframes())",
    "    count = len(pcm) // 2",
    "    return [int.from_bytes(pcm[index * 2:index * 2 + 2], \"little\", signed=True) / 32768.0 for index in range(count)]",
    "def dump_word(word):",
    "    return {\"word\": word.word, \"start\": float(word.start), \"end\": float(word.end), \"confidence\": float(word.confidence)}",
    "def dump_line(line):",
    "    words = []",
    "    if line.words:",
    "        for word in line.words:",
    "            words.append(dump_word(word))",
    "    return {\"text\": line.text, \"start_time\": float(line.start_time), \"duration\": float(line.duration), \"words\": words}",
    "def transcribe(message):",
    "    transcript = transcriber.transcribe_without_streaming(read_pcm(message[\"wavPath\"]))",
    "    return {\"lines\": [dump_line(line) for line in transcript.lines]}",
    "send({\"kind\": \"ready\"})",
    "serve(transcribe)",
].join("\n");
