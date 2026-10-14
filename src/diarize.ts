import { join } from "node:path";

import { EMBEDDING_SIZE } from "./embed.ts";
import { openFleet, type SpawnWorker } from "./fleet.ts";
import { homeFromEnv } from "./python-env.ts";
import { parseSpeakerTracks, type SpeakerTracks } from "./turns.ts";
import { PYTHON_FRAMES, spawnFramedWorker } from "./worker.ts";
import {
  digestStatus,
  ecapaSpec,
  FETCH_WEIGHTS_FIX,
  SEGMENTATION_FILE,
  segmentationSpec,
  type DigestStatus,
} from "./weights.ts";

export interface DiarizeCall {
  prepare(): Promise<void>;
  diarize(sourcePath: string): Promise<SpeakerTracks>;
}

export interface DiarizeHost extends DiarizeCall {
  close(): Promise<void>;
  /** Drop the idle worker and leave the host open. False means nothing changed. */
  release(): boolean;
}

export function segmentationWeightsPath(env: Readonly<Record<string, string | undefined>>): string {
  const configured = env["PODDRILL_SEGMENTATION_WEIGHTS"];
  if (configured !== undefined && configured !== "") {
    return configured;
  }
  return join(homeFromEnv(env), ".cache", "poddrill", "segmentation", SEGMENTATION_FILE);
}

export function openDiarizeHost(ecapaPath: string, segmentationPath: string): DiarizeHost {
  const pool = openFleet({
    limit: 1,
    spawn: spawnDiarizeWorker(ecapaPath, segmentationPath),
    closedMessage: "diarize host is closed",
  });
  const requireWeights = async (): Promise<void> => {
    const problems = [
      explainDigest("ECAPA", ecapaPath, await digestStatus(ecapaPath, ecapaSpec)),
      explainDigest(
        "segmentation",
        segmentationPath,
        await digestStatus(segmentationPath, segmentationSpec),
      ),
    ].filter((problem): problem is string => problem !== undefined);
    if (problems.length === 0) {
      return;
    }
    throw new Error(`${problems.join(" ")} Run ${FETCH_WEIGHTS_FIX}.`);
  };
  return {
    prepare: requireWeights,
    async diarize(sourcePath: string): Promise<SpeakerTracks> {
      await requireWeights();
      return pool.run(sourcePath);
    },
    close: () => pool.close(),
    release: () => pool.release(),
  };
}

function explainDigest(label: string, path: string, status: DigestStatus): string | undefined {
  switch (status) {
    case "match":
      return undefined;
    case "missing":
      return `${label} weights are missing at ${path}.`;
    case "mismatch":
      return `${label} weights at ${path} do not match the pinned file.`;
    default: {
      const leftover: never = status;
      throw new Error(`unexpected digest ${String(leftover)}`);
    }
  }
}

function spawnDiarizeWorker(ecapaPath: string, segmentationPath: string): SpawnWorker<SpeakerTracks> {
  return (events) => {
    const link = spawnFramedWorker(
      {
        label: "diarize",
        args: ["-c", WORKER_SCRIPT, ecapaPath, segmentationPath],
        checkReady: async () => undefined,
        parseResult: parseHostTracks,
      },
      events,
    );
    return {
      request: (sourcePath) => link.request({ wavPath: sourcePath }),
      close: () => link.close(),
    };
  };
}

function parseHostTracks(value: unknown): SpeakerTracks {
  const tracks = parseSpeakerTracks(value);
  if (tracks === undefined) {
    throw new Error("diarize result must be turns and centroids");
  }
  for (const centroid of tracks.centroids) {
    if (centroid.length !== EMBEDDING_SIZE) {
      throw new Error(`diarize centroid has ${centroid.length} values, not ${EMBEDDING_SIZE}`);
    }
  }
  return tracks;
}

const WORKER_SCRIPT = [
  PYTHON_FRAMES,
  "import subprocess",
  "import wave",
  "import numpy as np",
  "import onnxruntime as ort",
  "options = ort.SessionOptions()",
  "options.log_severity_level = 3",
  "ecapa = ort.InferenceSession(sys.argv[1], options, providers=[\"CPUExecutionProvider\"])",
  "seg = ort.InferenceSession(sys.argv[2], options, providers=[\"CPUExecutionProvider\"])",
  "ecapa_feed = ecapa.get_inputs()[0].name",
  "seg_feed = seg.get_inputs()[0].name",
  "RATE = 16000",
  "CHUNK = 160000",
  "HOP = 16000",
  "FRAME_STEP = 270",
  "FRAME = 400",
  "SHIFT = 160",
  "FFT = 512",
  "BINS = 80",
  "EPS = float(np.finfo(np.float32).eps)",
  "DIARIZATION_31_CENTROID_DISTANCE = 0.7045654963945799",
  "MIN_CLUSTER_SIZE = 12",
  "POWERSET = (frozenset(), frozenset({0}), frozenset({1}), frozenset({2}), frozenset({0, 1}), frozenset({0, 2}), frozenset({1, 2}))",
  "def mel(freq):",
  "    return 1127.0 * np.log(1.0 + freq / 700.0)",
  "def mel_banks():",
  "    low = mel(20.0)",
  "    delta = (mel(RATE / 2.0) - low) / (BINS + 1)",
  "    bins = mel(np.arange(FFT // 2) * (RATE / FFT))[None, :]",
  "    left = low + np.arange(BINS)[:, None] * delta",
  "    center = left + delta",
  "    right = center + delta",
  "    banks = np.maximum(0.0, np.minimum((bins - left) / delta, (right - bins) / delta))",
  "    return np.pad(banks, ((0, 0), (0, 1)))",
  "BANKS = mel_banks()",
  "WINDOW = 0.54 - 0.46 * np.cos(2.0 * np.pi * np.arange(FRAME) / (FRAME - 1))",
  "def fbank(samples):",
  "    scaled = samples.astype(np.float64) * 32768.0",
  "    if len(scaled) < FRAME:",
  "        raise ValueError(\"speaker span is shorter than one 25 ms frame\")",
  "    count = 1 + (len(scaled) - FRAME) // SHIFT",
  "    index = np.arange(FRAME)[None, :] + SHIFT * np.arange(count)[:, None]",
  "    frames = scaled[index]",
  "    frames = frames - frames.mean(axis=1, keepdims=True)",
  "    frames = frames - 0.97 * np.concatenate([frames[:, :1], frames[:, :-1]], axis=1)",
  "    power = np.abs(np.fft.rfft(frames * WINDOW, n=FFT)) ** 2",
  "    return np.log(np.maximum(power @ BANKS.T, EPS))",
  "def read_wav(path):",
  "    with wave.open(path, \"rb\") as reader:",
  "        if reader.getnchannels() != 1 or reader.getsampwidth() != 2 or reader.getframerate() != RATE:",
  "            raise ValueError(path + \" is not 16-bit mono 16 kHz wav\")",
  "        pcm = reader.readframes(reader.getnframes())",
  "    return np.frombuffer(pcm, dtype=\"<i2\").astype(np.float32) / np.float32(32768.0)",
  "def load_audio(path):",
  "    try:",
  "        return read_wav(path)",
  "    except (ValueError, wave.Error, FileNotFoundError):",
  "        pass",
  "    proc = subprocess.run([\"ffmpeg\", \"-hide_banner\", \"-loglevel\", \"error\", \"-nostdin\", \"-i\", path, \"-ac\", \"1\", \"-ar\", str(RATE), \"-f\", \"s16le\", \"-c:a\", \"pcm_s16le\", \"pipe:1\"], check=False, capture_output=True)",
  "    if proc.returncode != 0 or len(proc.stdout) < 2 or len(proc.stdout) % 2 != 0:",
  "        raise ValueError(path + \" is not decodable audio\")",
  "    return np.frombuffer(proc.stdout, dtype=\"<i2\").astype(np.float32) / np.float32(32768.0)",
  "def chunk_audio(audio, start):",
  "    piece = audio[start : start + CHUNK]",
  "    if len(piece) == CHUNK:",
  "        return piece",
  "    padded = np.zeros(CHUNK, dtype=np.float32)",
  "    padded[: len(piece)] = piece",
  "    return padded",
  "def segment_all(audio):",
  "    starts = list(range(0, len(audio), HOP))",
  "    classes = np.empty((len(starts), 589), dtype=np.uint8)",
  "    batch = 16",
  "    for offset in range(0, len(starts), batch):",
  "        group = starts[offset : offset + batch]",
  "        wavs = np.stack([chunk_audio(audio, start) for start in group])[:, None, :]",
  "        logits = seg.run(None, {seg_feed: wavs})[0]",
  "        classes[offset : offset + len(group)] = np.argmax(logits, axis=-1).astype(np.uint8)",
  "    return classes",
  "def speaker_samples(chunk, classes, speaker):",
  "    active = np.zeros(CHUNK, dtype=bool)",
  "    clean = np.zeros(CHUNK, dtype=bool)",
  "    for frame, label in enumerate(classes):",
  "        members = POWERSET[int(label)]",
  "        if speaker not in members:",
  "            continue",
  "        begin = frame * FRAME_STEP",
  "        end = min(CHUNK, begin + FRAME_STEP)",
  "        active[begin:end] = True",
  "        if len(members) == 1:",
  "            clean[begin:end] = True",
  "    chosen = clean if int(clean.sum()) > 400 else active",
  "    if int(chosen.sum()) <= 400:",
  "        return np.empty(0, dtype=np.float32)",
  "    return chunk[chosen]",
  "def embed_one(samples):",
  "    feats = fbank(samples)",
  "    feats = feats - feats.mean(axis=0, keepdims=True)",
  "    output = ecapa.run(None, {ecapa_feed: feats[None, :, :].astype(np.float32)})[0]",
  "    return np.asarray(output, dtype=np.float32).reshape(-1)",
  "def embed_all(audio, classes):",
  "    vectors = np.full((classes.shape[0], 3, 192), np.nan, dtype=np.float32)",
  "    for index, start in enumerate(range(0, len(audio), HOP)):",
  "        chunk = chunk_audio(audio, start)",
  "        row = classes[index]",
  "        for speaker in range(3):",
  "            samples = speaker_samples(chunk, row, speaker)",
  "            if len(samples) == 0:",
  "                continue",
  "            try:",
  "                vectors[index, speaker] = embed_one(samples)",
  "            except ValueError:",
  "                pass",
  "    return vectors",
  "def centroid_merges(unit):",
  "    n = unit.shape[0]",
  "    dist2 = np.sum(unit * unit, axis=1)[:, None] + np.sum(unit * unit, axis=1)[None, :] - 2.0 * (unit @ unit.T)",
  "    np.fill_diagonal(dist2, np.inf)",
  "    dist2[dist2 < 0] = 0",
  "    sizes = np.ones(n, dtype=np.int64)",
  "    active = np.ones(n, dtype=bool)",
  "    node_of = np.arange(n, dtype=np.int64)",
  "    next_id = n",
  "    nn = np.argmin(dist2, axis=1)",
  "    nnd = dist2[np.arange(n), nn]",
  "    merges = []",
  "    for _ in range(n - 1):",
  "        active_idx = np.flatnonzero(active)",
  "        a = int(active_idx[np.argmin(nnd[active_idx])])",
  "        b = int(nn[a])",
  "        d_ab = float(dist2[a, b])",
  "        left = int(node_of[a])",
  "        right = int(node_of[b])",
  "        if left > right:",
  "            left, right = right, left",
  "        merges.append((left, right, float(np.sqrt(max(d_ab, 0.0)))))",
  "        na = float(sizes[a])",
  "        nb = float(sizes[b])",
  "        nt = na + nb",
  "        row = (na / nt) * dist2[a] + (nb / nt) * dist2[b] + (-(na * nb) / (nt * nt)) * d_ab",
  "        active[b] = False",
  "        row[~active] = np.inf",
  "        row[a] = np.inf",
  "        row[row < 0] = 0",
  "        dist2[a, :] = row",
  "        dist2[:, a] = row",
  "        dist2[b, :] = np.inf",
  "        dist2[:, b] = np.inf",
  "        sizes[a] = int(na + nb)",
  "        node_of[a] = next_id",
  "        next_id += 1",
  "        invalid = ((nn == a) | (nn == b) | (np.arange(n) == a)) & active",
  "        rows = np.flatnonzero(invalid)",
  "        if len(rows) > 0:",
  "            sub = dist2[rows]",
  "            chosen = np.argmin(sub, axis=1)",
  "            nn[rows] = chosen",
  "            nnd[rows] = sub[np.arange(len(rows)), chosen]",
  "        valid = active & ~invalid",
  "        closer = valid & (dist2[:, a] < nnd)",
  "        nn[closer] = a",
  "        nnd[closer] = dist2[closer, a]",
  "    return merges",
  "def flat_clusters(merges, n, threshold):",
  "    if n == 1:",
  "        return np.array([0], dtype=np.int32)",
  "    labels = np.full(n, -1, dtype=np.int32)",
  "    visited = np.zeros(2 * n - 1, dtype=bool)",
  "    stack_node = np.zeros(n, dtype=np.int32)",
  "    k = 0",
  "    stack_node[0] = 2 * n - 2",
  "    leader = -1",
  "    while k >= 0:",
  "        node = int(stack_node[k])",
  "        root = node - n",
  "        left, right, dist = merges[root]",
  "        if leader == -1 and dist <= threshold:",
  "            leader = node",
  "        if left >= n and not visited[left]:",
  "            visited[left] = True",
  "            k += 1",
  "            stack_node[k] = left",
  "            continue",
  "        if right >= n and not visited[right]:",
  "            visited[right] = True",
  "            k += 1",
  "            stack_node[k] = right",
  "            continue",
  "        if left < n:",
  "            labels[left] = leader",
  "        if right < n:",
  "            labels[right] = leader",
  "        if leader == node:",
  "            leader = -1",
  "        k -= 1",
  "    singleton = -2",
  "    for index in range(n):",
  "        if labels[index] < 0:",
  "            labels[index] = singleton",
  "            singleton -= 1",
  "    return labels",
  "def cluster_unit(unit):",
  "    count = unit.shape[0]",
  "    if count == 1:",
  "        return np.array([0], dtype=np.int32), unit.copy()",
  "    merges = centroid_merges(unit)",
  "    labels = flat_clusters(merges, count, DIARIZATION_31_CENTROID_DISTANCE)",
  "    ids, counts = np.unique(labels, return_counts=True)",
  "    min_size = min(MIN_CLUSTER_SIZE, max(1, round(0.1 * count)))",
  "    large = ids[counts >= min_size]",
  "    if len(large) == 0:",
  "        labels = np.zeros(count, dtype=np.int32)",
  "        return labels, unit.mean(axis=0, keepdims=True)",
  "    large_centroids = np.vstack([unit[labels == kid].mean(axis=0) for kid in large])",
  "    small = ids[counts < min_size]",
  "    for kid in small:",
  "        members = labels == kid",
  "        centroid = unit[members].mean(axis=0)",
  "        nearest = int(np.argmin(np.linalg.norm(large_centroids - centroid, axis=1)))",
  "        labels[members] = large[nearest]",
  "    _, compact = np.unique(labels, return_inverse=True)",
  "    compact = compact.astype(np.int32)",
  "    speakers = int(compact.max()) + 1",
  "    centroids = np.vstack([unit[compact == kid].mean(axis=0) for kid in range(speakers)])",
  "    return compact, centroids",
  "def cluster_windows(vectors):",
  "    flat = vectors.reshape(-1, 192)",
  "    finite = np.isfinite(flat).all(axis=1)",
  "    labels = np.full(flat.shape[0], -2, dtype=np.int32)",
  "    points = flat[finite]",
  "    if len(points) == 0:",
  "        return labels.reshape(vectors.shape[:2]), []",
  "    norms = np.maximum(np.linalg.norm(points, axis=1, keepdims=True), 1e-12)",
  "    compact, centroids = cluster_unit(points / norms)",
  "    labels[finite] = compact",
  "    return labels.reshape(vectors.shape[:2]), [[float(value) for value in row] for row in centroids]",
  "def stitch(audio_len, classes, hard):",
  "    n_speakers = int(hard.max()) + 1 if np.any(hard >= 0) else 0",
  "    if n_speakers <= 0:",
  "        return []",
  "    n_global = (audio_len + FRAME_STEP - 1) // FRAME_STEP",
  "    votes = np.zeros((n_global, n_speakers), dtype=np.uint16)",
  "    for index, start in enumerate(range(0, audio_len, HOP)):",
  "        row = classes[index]",
  "        ids = hard[index]",
  "        for frame, label in enumerate(row):",
  "            members = POWERSET[int(label)]",
  "            if not members:",
  "                continue",
  "            global_frame = (start + frame * FRAME_STEP) // FRAME_STEP",
  "            if global_frame >= n_global:",
  "                break",
  "            for speaker in members:",
  "                cluster_id = int(ids[speaker])",
  "                if cluster_id < 0:",
  "                    continue",
  "                votes[global_frame, cluster_id] = min(65535, int(votes[global_frame, cluster_id]) + 1)",
  "    winner = votes.argmax(axis=1)",
  "    winner[votes.max(axis=1) == 0] = -1",
  "    turns = []",
  "    frame = 0",
  "    while frame < n_global:",
  "        speaker = int(winner[frame])",
  "        end = frame + 1",
  "        while end < n_global and int(winner[end]) == speaker:",
  "            end += 1",
  "        if speaker >= 0:",
  "            start_ms = (frame * FRAME_STEP * 1000) // RATE",
  "            end_sample = end * FRAME_STEP",
  "            if end_sample > audio_len:",
  "                end_sample = audio_len",
  "            end_ms = (end_sample * 1000) // RATE",
  "            if end_ms > start_ms:",
  "                turns.append({\"startMs\": int(start_ms), \"endMs\": int(end_ms), \"speaker\": speaker})",
  "        frame = end",
  "    return turns",
  "def diarize(message):",
  "    audio = load_audio(message[\"wavPath\"])",
  "    if len(audio) == 0:",
  "        return {\"turns\": [], \"centroids\": []}",
  "    classes = segment_all(audio)",
  "    vectors = embed_all(audio, classes)",
  "    hard, centroids = cluster_windows(vectors)",
  "    return {\"turns\": stitch(len(audio), classes, hard), \"centroids\": centroids}",
  "send({\"kind\": \"ready\"})",
  "serve(diarize)",
].join("\n");
