/**
 * The episode store. One instance per workspace, held by the owner process.
 * Invariants:
 * - This module is the only writer under `episodes/`. Its write helpers are not exported.
 * - The in-memory entries mirror the episode directories. The single writer keeps them in sync.
 * - Each artifact kind runs one episode at a time. Parallelism is inside that stage.
 * - An artifact's state is derived from which files exist. A ready output wins over `failed.json`.
 */

import { createHash, randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  copyFile,
  link,
  mkdir,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { basename, extname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { cutSlice, probeDurationMs } from "./audio.ts";
import { asRecord, errorCode, pathExists, readJsonFile } from "./disk.ts";
import type { EmbedCall } from "./embed.ts";
import {
  parseWhistle,
  planSlices,
  projectSlices,
  serializeWhistle,
  type PlannedSlice,
  type SliceRecord,
} from "./episode.ts";
import {
  assignCues,
  cueRows,
  hostNames,
  knownGroupIds,
  mergeLabels,
  pageCues,
  parseLabelUpdates,
  readAssignments,
  readLabels,
  readStretchVectors,
  readVttCues,
  type CueRow,
  type StretchVector,
  type CueText,
  type StoredLabel,
} from "./groups.ts";
import { fleetSize, modelForLanguage } from "./models.ts";
import { transcriptRefusal, type WhistleCall } from "./provider.ts";
import { planStretches, readCueSpans } from "./stretch.ts";
import {
  dumpSummary,
  emptySummary,
  inspectPostBody,
  inspectPutBody,
  parseSummaryFile,
  orderCueSet,
  freshSummaryId,
  parseSummaryId,
  requireSummaryText,
  type CueSetInput,
  type SummaryDocument,
  type SummaryHead,
  type SummaryId,
  type SummaryParagraph,
} from "./summary.ts";
import {
  artifactKinds,
  episodeIdFromDigest,
  episodeLayout,
  parseEpisodeId,
  sliceFiles,
  stretchWav,
  workspaceDirs,
  type ArtifactKind,
  type ArtifactLayout,
  type EpisodeId,
  type EpisodeLayout,
  type WorkspaceConfig,
  type WorkspaceRoot,
} from "./workspace.ts";

/**
 * `waiting` names the artifact it needs and has no progress.
 * `queued` and `running` progress runs 0 through 99. Only `ready` carries 100 and a path.
 */
export type ArtifactState =
  | { readonly state: "waiting"; readonly on: ArtifactKind }
  | { readonly state: "queued"; readonly position: number; readonly progress: number }
  | { readonly state: "running"; readonly progress: number }
  | { readonly state: "ready"; readonly progress: 100; readonly path: string }
  | { readonly state: "failed"; readonly progress: number; readonly message: string };

export type ArtifactRecord = { readonly artifact: ArtifactKind } & ArtifactState;

/** `artifacts` is always transcript, then embedding. */
export interface Episode {
  readonly state: "present";
  readonly episodeId: EpisodeId;
  /** The episode's own hardlink of the audio. Survives the agent deleting its copy in `audio/`. */
  readonly sourcePath: string;
  readonly durationMs: number;
  /** Chosen at the first start. A later start of the same audio keeps this code. */
  readonly language: string;
  readonly artifacts: readonly ArtifactRecord[];
  readonly summaries: readonly SummaryHead[];
}

export type EpisodeRead = Episode | { readonly state: "unknown"; readonly episodeId: string };

export interface CueQuery {
  readonly limit?: number;
  readonly after?: string;
  readonly groupId?: string;
  readonly hosts?: boolean;
}

type EpisodeMiss =
  | { readonly state: "unknown"; readonly episodeId: string }
  | { readonly state: "not-ready"; readonly episodeId: EpisodeId; readonly on: "embedding" }
  | { readonly kind: "error"; readonly message: string };

export type CuesRead =
  | {
      readonly state: "present";
      readonly episodeId: EpisodeId;
      readonly cues: readonly CueRow[];
      readonly hostNames?: readonly string[];
    }
  | { readonly state: "unknown"; readonly episodeId: EpisodeId; readonly groupId: string }
  | { readonly state: "unknown"; readonly episodeId: EpisodeId; readonly cueId: string }
  | { readonly kind: "rejected"; readonly reason: "limit"; readonly message: string }
  | EpisodeMiss;

export type LabelGroupsRead =
  | { readonly state: "present"; readonly episodeId: EpisodeId; readonly labels: readonly StoredLabel[] }
  | { readonly state: "unknown"; readonly episodeId: EpisodeId; readonly groupId: string }
  | EpisodeMiss;

export type SummaryRead =
  | {
      readonly state: "present";
      readonly episodeId: EpisodeId;
      readonly version: 1;
      readonly summaryId: SummaryId;
      readonly summary: string;
      readonly paragraphs: readonly SummaryParagraph[];
    }
  | { readonly state: "unknown"; readonly episodeId: string }
  | { readonly state: "unknown"; readonly episodeId: string; readonly summaryId: string }
  | { readonly state: "not-ready"; readonly episodeId: EpisodeId; readonly on: "transcript" }
  | { readonly kind: "error"; readonly message: string };

interface LoadedCues {
  readonly episodeId: EpisodeId;
  readonly rows: readonly CueRow[];
  readonly labels: readonly StoredLabel[];
}

type StoredRows =
  | { readonly kind: "rows"; readonly rows: readonly CueRow[] }
  | { readonly kind: "missing-groups" }
  | { readonly kind: "unreadable" };

export type StartRejection = "outside-audio-dir" | "not-found" | "not-audio" | "unknown-language";

/**
 * `started` covers a new episode, an existing one in any state, and a retried failed artifact.
 * Dedupe runs before the capacity check, so known audio is never `full` unless its transcript failed.
 * `full` writes nothing. `unfinished` lists the running transcript, then the queued ones in run order.
 */
export type StartResult =
  | { readonly kind: "started"; readonly created: boolean; readonly episode: Episode }
  | { readonly kind: "full"; readonly queueLength: number; readonly unfinished: readonly EpisodeId[] }
  | { readonly kind: "rejected"; readonly reason: StartRejection; readonly message: string };

type Rejected = Extract<StartResult, { readonly kind: "rejected" }>;

/** The host each stage calls. Neither can end the host it uses. */
export interface StoreHosts {
  readonly whistle: WhistleCall;
  readonly embed: EmbedCall;
}

/** An artifact runs only after the one it names here is ready. */
const DEPENDS_ON: Readonly<Record<ArtifactKind, ArtifactKind | undefined>> = {
  transcript: undefined,
  embedding: "transcript",
};

/** `episode.json`. Immutable after the admit rename. */
interface EpisodeManifest {
  readonly episodeId: EpisodeId;
  readonly sha256: string;
  /** Basename the agent used in `audio/`, for humans reading the episode dir. */
  readonly sourceName: string;
  /** `source.mp3` and so on, relative to the episode dir. */
  readonly sourceFile: string;
  readonly durationMs: number;
  /** ISO 8601. Run order among pending artifacts of one kind. A retry keeps it. */
  readonly enqueuedAt: string;
  /** Missing on an old `episode.json` reads as `en`. */
  readonly language: string;
}

/** Derived from which files exist. Never persisted as a field. `total` is 0 until the stage plans its units. */
type ArtifactProgress =
  | { readonly kind: "pending"; readonly done: number; readonly total: number }
  | { readonly kind: "ready" }
  | { readonly kind: "failed"; readonly message: string; readonly done: number; readonly total: number };

interface EpisodeEntry {
  readonly manifest: EpisodeManifest;
  readonly plan: readonly PlannedSlice[];
  readonly artifacts: Readonly<Record<ArtifactKind, ArtifactProgress>>;
}

type Admission =
  | { readonly kind: "existing"; readonly entry: EpisodeEntry }
  | { readonly kind: "retry"; readonly entry: EpisodeEntry; readonly kinds: readonly ArtifactKind[] }
  | { readonly kind: "admit" }
  | { readonly kind: "full"; readonly unfinished: readonly EpisodeId[] };

interface StageRun {
  readonly entry: EpisodeEntry;
  readonly layout: EpisodeLayout;
  readonly signal: AbortSignal;
  report(done: number, total: number): void;
}

export class JobQueue {
  private readonly root: WorkspaceRoot;
  private readonly config: WorkspaceConfig;
  private readonly hosts: StoreHosts;
  private readonly entries = new Map<EpisodeId, EpisodeEntry>();
  /** Starts past the capacity check whose episode dir is not committed yet. Counted against capacity. */
  private readonly admitting = new Map<EpisodeId, Promise<StartResult>>();
  /** Two calls for one episode must not read labels.json until the earlier rename has finished. */
  private readonly episodeWrites = new Map<EpisodeId, Promise<void>>();
  private readonly summaryHeads = new Map<EpisodeId, readonly SummaryHead[]>();
  private readonly stop = new AbortController();
  /** The episode each stage holds. `running` for that kind is exactly this id. */
  private readonly running = new Map<ArtifactKind, EpisodeId>();
  private readonly afterLabelRead: (() => Promise<void>) | undefined;

  private constructor(
    root: WorkspaceRoot,
    config: WorkspaceConfig,
    hosts: StoreHosts,
    afterLabelRead: (() => Promise<void>) | undefined,
  ) {
    this.root = root;
    this.config = config;
    this.hosts = hosts;
    this.afterLabelRead = afterLabelRead;
  }

  /** Sweep uncommitted writes, load every episode dir, and resume the oldest pending work of each kind. */
  static async open(
    root: WorkspaceRoot,
    config: WorkspaceConfig,
    hosts: StoreHosts,
    hooks?: { readonly afterLabelRead?: () => Promise<void> },
  ): Promise<JobQueue> {
    const queue = new JobQueue(root, config, hosts, hooks?.afterLabelRead);
    for (const entry of await loadEpisodes(root)) {
      const id = entry.manifest.episodeId;
      queue.entries.set(id, entry);
      queue.summaryHeads.set(id, await loadSummaryHeads(episodeLayout(root, id), id));
    }
    queue.wakeAll();
    return queue;
  }

  /** Admit one audio file under `audio/`. Idempotent per audio bytes. An omitted language is `en`. */
  async start(audioPath: string, language = "en"): Promise<StartResult> {
    if (this.stop.signal.aborted) {
      throw new Error("episode store is closed");
    }
    const located = await locateAudio(this.root, audioPath);
    if (located.kind === "rejected") {
      return located;
    }
    const digest = await sha256File(located.path);
    const id = episodeIdFromDigest(digest);
    const pending = this.admitting.get(id);
    if (pending !== undefined) {
      return pending.then((result) =>
        result.kind === "started" ? { ...result, created: false } : result,
      );
    }
    if (this.entries.get(id) === undefined && modelForLanguage(language) === undefined) {
      return rejected("unknown-language", `unknown language ${language}`);
    }
    const admission = admit(
      this.entries,
      this.runOrder("transcript"),
      this.admitting.size,
      this.config.queueLength,
      id,
    );
    switch (admission.kind) {
      case "existing":
        return { kind: "started", created: false, episode: this.present(admission.entry) };
      case "retry":
        return this.retry(admission.entry, admission.kinds);
      case "full":
        return { kind: "full", queueLength: this.config.queueLength, unfinished: admission.unfinished };
      case "admit": {
        const admitting = this.create(id, digest, located.path, language).finally(() => {
          this.admitting.delete(id);
        });
        this.admitting.set(id, admitting);
        return admitting;
      }
      default: {
        const leftover: never = admission;
        throw new Error(`unexpected admission ${JSON.stringify(leftover)}`);
      }
    }
  }

  /** Pure read of the entries. Never touches disk. */
  episode(episodeId: string): EpisodeRead {
    const id = parseEpisodeId(episodeId);
    const entry = id === undefined ? undefined : this.entries.get(id);
    if (entry === undefined) {
      return { state: "unknown", episodeId };
    }
    return this.present(entry);
  }

  async cues(episodeId: string, query: CueQuery = {}): Promise<CuesRead> {
    this.requireOpen();
    const limit = resolveLimit(query.limit);
    if (typeof limit !== "number") {
      return limit;
    }
    const id = parseEpisodeId(episodeId);
    if (id === undefined || !this.entries.has(id)) {
      return { state: "unknown", episodeId };
    }
    return this.withEpisode(id, async () => {
      const loaded = await this.loadCueRows(episodeId);
      if (!("rows" in loaded)) {
        return loaded;
      }
      const page = pageCues(loaded.rows, knownGroupIds(loaded.rows), limit, query.after, query.groupId);
      switch (page.kind) {
        case "unknown-group":
          return { state: "unknown", episodeId: loaded.episodeId, groupId: page.groupId };
        case "unknown-cue":
          return { state: "unknown", episodeId: loaded.episodeId, cueId: page.cueId };
        case "page":
          if (query.hosts === true) {
            return {
              state: "present",
              episodeId: loaded.episodeId,
              cues: page.cues,
              hostNames: hostNames(loaded.labels),
            };
          }
          return { state: "present", episodeId: loaded.episodeId, cues: page.cues };
        default: {
          const leftover: never = page;
          throw new Error(`unexpected page ${JSON.stringify(leftover)}`);
        }
      }
    });
  }

  async labelGroups(episodeId: string, groups: unknown): Promise<LabelGroupsRead> {
    this.requireOpen();
    const updates = parseLabelUpdates(groups);
    if (updates === undefined) {
      return {
        kind: "error",
        message: "labelGroups expects a JSON array of { groupId, label }",
      };
    }
    const id = parseEpisodeId(episodeId);
    if (id === undefined || !this.entries.has(id)) {
      return { state: "unknown", episodeId };
    }
    return this.withEpisode(id, async () => {
      const loaded = await this.loadCueRows(episodeId);
      if (!("rows" in loaded)) {
        return loaded;
      }
      const known = knownGroupIds(loaded.rows);
      for (const update of updates) {
        if (!known.has(update.groupId)) {
          return { state: "unknown", episodeId: loaded.episodeId, groupId: update.groupId };
        }
      }
      const labels = mergeLabels(loaded.labels, updates);
      if (this.afterLabelRead !== undefined) {
        await this.afterLabelRead();
      }
      const layout = episodeLayout(this.root, loaded.episodeId);
      const wrote = await commitFile(layout.labels, this.stop.signal, (temp) =>
        writeFile(temp, `${JSON.stringify({ groups: labels }, null, 2)}\n`),
      );
      if (!wrote) {
        throw new Error("episode store is closed");
      }
      return { state: "present", episodeId: loaded.episodeId, labels };
    });
  }

  async startSummary(episodeId: string): Promise<SummaryRead> {
    this.requireOpen();
    const id = this.knownEpisode(episodeId);
    if (id === undefined) {
      return { state: "unknown", episodeId };
    }
    return this.withEpisode(id, async () => {
      for (let attempt = 0; attempt < 8; attempt += 1) {
        const summaryId = freshSummaryId();
        const existing = await this.loadSummaryDocument(id, summaryId);
        if (existing.kind !== "missing") {
          continue;
        }
        const created = emptySummary(id, summaryId);
        await this.storeSummary(id, created);
        return presentSummary(id, created);
      }
      return { kind: "error", message: "could not start a summary" };
    });
  }

  async setSummary(episodeId: string, summaryId: string, summary: unknown): Promise<SummaryRead> {
    this.requireOpen();
    const text = requireSummaryText(summary);
    if (!text.ok) {
      return { kind: "error", message: text.message };
    }
    const id = this.knownEpisode(episodeId);
    if (id === undefined) {
      return { state: "unknown", episodeId };
    }
    const parsedId = parseSummaryId(summaryId);
    if (parsedId === undefined) {
      return { state: "unknown", episodeId: id, summaryId };
    }
    return this.withEpisode(id, async () => {
      const loaded = await this.loadSummaryDocument(id, parsedId);
      if (loaded.kind === "missing") {
        return { state: "unknown", episodeId: id, summaryId: parsedId };
      }
      if (loaded.kind === "error") {
        return loaded;
      }
      if (loaded.document.paragraphs.length === 0) {
        return { kind: "error", message: "write the paragraphs before the episode summary" };
      }
      const next: SummaryDocument = { ...loaded.document, summary: text.value };
      await this.storeSummary(id, next);
      return presentSummary(id, next);
    });
  }

  async postParagraph(episodeId: string, summaryId: string, body: unknown): Promise<SummaryRead> {
    this.requireOpen();
    const span = inspectPostBody(body);
    if (!span.ok) {
      return { kind: "error", message: span.message };
    }
    return this.changeParagraph(episodeId, summaryId, span.value, undefined);
  }

  async putParagraph(episodeId: string, summaryId: string, body: unknown): Promise<SummaryRead> {
    this.requireOpen();
    const span = inspectPutBody(body);
    if (!span.ok) {
      return { kind: "error", message: span.message };
    }
    return this.changeParagraph(episodeId, summaryId, span.value, span.value.index);
  }

  async summary(episodeId: string, summaryId: string): Promise<SummaryRead> {
    this.requireOpen();
    const id = this.knownEpisode(episodeId);
    if (id === undefined) {
      return { state: "unknown", episodeId };
    }
    const parsedId = parseSummaryId(summaryId);
    if (parsedId === undefined) {
      return { state: "unknown", episodeId: id, summaryId };
    }
    return this.withEpisode(id, async () => {
      const loaded = await this.loadSummaryDocument(id, parsedId);
      if (loaded.kind === "missing") {
        return { state: "unknown", episodeId: id, summaryId: parsedId };
      }
      if (loaded.kind === "error") {
        return loaded;
      }
      return presentSummary(id, loaded.document);
    });
  }

  /** True when no artifact of `kind` is queued or running. The owner's idle timer for that host reads it. */
  idle(kind: ArtifactKind): boolean {
    const admitting = kind === "transcript" ? this.admitting.size : 0;
    return admitting === 0 && this.runOrder(kind).length === 0;
  }

  /**
   * Stop every stage without waiting for the work in flight. Nothing from it is renamed into place,
   * so close and a crash leave the same disk state. Pending artifacts resume at the next `open`.
   * The caller owns the hosts and closes them separately.
   */
  async close(): Promise<void> {
    this.stop.abort();
  }

  private requireOpen(): void {
    if (this.stop.signal.aborted) {
      throw new Error("episode store is closed");
    }
  }

  private knownEpisode(episodeId: string): EpisodeId | undefined {
    const id = parseEpisodeId(episodeId);
    if (id === undefined || !this.entries.has(id)) {
      return undefined;
    }
    return id;
  }

  private async changeParagraph(
    episodeId: string,
    summaryId: string,
    span: CueSetInput,
    index: number | undefined,
  ): Promise<SummaryRead> {
    const id = this.knownEpisode(episodeId);
    if (id === undefined) {
      return { state: "unknown", episodeId };
    }
    const parsedId = parseSummaryId(summaryId);
    if (parsedId === undefined) {
      return { state: "unknown", episodeId: id, summaryId };
    }
    return this.withEpisode(id, async () => {
      const entry = this.entries.get(id);
      if (entry === undefined) {
        return { state: "unknown", episodeId: id };
      }
      if (entry.artifacts.transcript.kind !== "ready") {
        return { state: "not-ready", episodeId: id, on: "transcript" };
      }
      const loaded = await this.loadSummaryDocument(id, parsedId);
      if (loaded.kind === "missing") {
        return { state: "unknown", episodeId: id, summaryId: parsedId };
      }
      if (loaded.kind === "error") {
        return loaded;
      }
      if (index !== undefined && !loaded.document.paragraphs.some((paragraph) => paragraph.index === index)) {
        return { kind: "error", message: "putParagraph index does not exist" };
      }
      const cues = await this.readTranscriptCues(id);
      if (cues === undefined) {
        return { kind: "error", message: "the transcript could not be read" };
      }
      const times = orderCueSet(span.cues, span.startMs, span.endMs, cues);
      if (!times.ok) {
        return { kind: "error", message: times.message };
      }
      const paragraph: SummaryParagraph = {
        index: index ?? loaded.document.paragraphs.length + 1,
        text: span.text,
        cues: times.value.cues,
        startMs: times.value.startMs,
        endMs: times.value.endMs,
      };
      const paragraphs =
        index === undefined
          ? [...loaded.document.paragraphs, paragraph]
          : loaded.document.paragraphs.map((item) => (item.index === index ? paragraph : item));
      const next: SummaryDocument = { ...loaded.document, paragraphs };
      await this.storeSummary(id, next);
      return presentSummary(id, next);
    });
  }

  private async loadSummaryDocument(
    episodeId: EpisodeId,
    summaryId: SummaryId,
  ): Promise<
    | { readonly kind: "ok"; readonly document: SummaryDocument }
    | { readonly kind: "missing" }
    | { readonly kind: "error"; readonly message: string }
  > {
    const path = episodeLayout(this.root, episodeId).summaryFile(summaryId);
    let text: string;
    try {
      text = await readFile(path, "utf8");
    } catch (error) {
      if (errorCode(error) === "ENOENT") {
        return { kind: "missing" };
      }
      return { kind: "error", message: "the summary could not be read" };
    }
    const document = parseSummaryFile(text, episodeId, summaryId);
    if (document === undefined) {
      return { kind: "error", message: "the summary could not be read" };
    }
    return { kind: "ok", document };
  }

  private async readTranscriptCues(episodeId: EpisodeId): Promise<readonly CueText[] | undefined> {
    try {
      const vtt = await readFile(episodeLayout(this.root, episodeId).artifacts.transcript.output, "utf8");
      return readVttCues(vtt);
    } catch {
      return undefined;
    }
  }

  private async storeSummary(episodeId: EpisodeId, document: SummaryDocument): Promise<void> {
    const layout = episodeLayout(this.root, episodeId);
    await mkdir(layout.summaries, { recursive: true });
    const wrote = await commitFile(layout.summaryFile(document.summaryId), this.stop.signal, (temp) =>
      writeFile(temp, dumpSummary(document)),
    );
    if (!wrote) {
      throw new Error("episode store is closed");
    }
    this.rememberSummary(episodeId, document);
  }

  private rememberSummary(episodeId: EpisodeId, document: SummaryDocument): void {
    const head: SummaryHead = {
      summaryId: document.summaryId,
    };
    const current = this.summaryHeads.get(episodeId) ?? [];
    if (current.some((item) => item.summaryId === head.summaryId)) {
      return;
    }
    const summaries = [...current, head].sort((left, right) =>
      compareText(left.summaryId, right.summaryId),
    );
    this.summaryHeads.set(episodeId, summaries);
  }

  private withEpisode<T>(episodeId: EpisodeId, work: () => Promise<T>): Promise<T> {
    const previous = this.episodeWrites.get(episodeId) ?? Promise.resolve();
    const settled = previous.then(
      () => undefined,
      () => undefined,
    );
    const run = settled.then(work);
    this.episodeWrites.set(
      episodeId,
      run.then(
        () => undefined,
        () => undefined,
      ),
    );
    return run;
  }

  private async loadCueRows(episodeId: string): Promise<LoadedCues | EpisodeMiss> {
    const id = parseEpisodeId(episodeId);
    const entry = id === undefined ? undefined : this.entries.get(id);
    if (id === undefined || entry === undefined) {
      return { state: "unknown", episodeId };
    }
    if (entry.artifacts.embedding.kind !== "ready") {
      return { state: "not-ready", episodeId: id, on: "embedding" };
    }
    const layout = episodeLayout(this.root, id);
    const stored = await readStoredRows(layout);
    if (stored.kind !== "rows") {
      if (this.stop.signal.aborted) {
        throw new Error("episode store is closed");
      }
      if (stored.kind === "missing-groups") {
        this.setArtifact(id, "embedding", { kind: "pending", done: 0, total: 0 });
        this.wake("embedding");
        return { state: "not-ready", episodeId: id, on: "embedding" };
      }
      if (stored.kind === "unreadable") {
        return { kind: "error", message: "the transcript or embedding could not be read" };
      }
      const unreachable: never = stored;
      throw new Error(`unexpected stored rows ${unreachable}`);
    }
    const rows = stored.rows;
    const labels = await readStoredLabels(layout.labels);
    if (labels === undefined) {
      return { kind: "error", message: "labels.json could not be read" };
    }
    return { episodeId: id, rows, labels };
  }

  private present(entry: EpisodeEntry): Episode {
    const id = entry.manifest.episodeId;
    const layout = episodeLayout(this.root, id);
    return {
      state: "present",
      episodeId: id,
      sourcePath: join(layout.dir, entry.manifest.sourceFile),
      durationMs: entry.manifest.durationMs,
      language: entry.manifest.language,
      artifacts: artifactKinds.map((kind) => ({
        artifact: kind,
        ...artifactState(entry, kind, layout.artifacts[kind], this.runOrder(kind), this.running.get(kind)),
      })),
      summaries: this.summaryHeads.get(id) ?? [],
    };
  }

  private setArtifact(id: EpisodeId, kind: ArtifactKind, progress: ArtifactProgress): void {
    const entry = this.entries.get(id);
    if (entry !== undefined) {
      this.entries.set(id, { ...entry, artifacts: { ...entry.artifacts, [kind]: progress } });
    }
  }

  /** Pending artifacts of `kind` whose dependency is ready, by enqueuedAt, then id. */
  private eligible(kind: ArtifactKind): readonly EpisodeEntry[] {
    const dependency = DEPENDS_ON[kind];
    return [...this.entries.values()]
      .filter(
        (entry) =>
          entry.artifacts[kind].kind === "pending" &&
          (dependency === undefined || entry.artifacts[dependency].kind === "ready"),
      )
      .sort((a, b) => {
        const byTime = compareText(a.manifest.enqueuedAt, b.manifest.enqueuedAt);
        return byTime !== 0 ? byTime : compareText(a.manifest.episodeId, b.manifest.episodeId);
      });
  }

  /** The running episode first, because a retried older episode can sort ahead of it. Then queue order. */
  private runOrder(kind: ArtifactKind): readonly EpisodeId[] {
    const ids = this.eligible(kind).map((entry) => entry.manifest.episodeId);
    const running = this.running.get(kind);
    if (running === undefined || !ids.includes(running)) {
      return ids;
    }
    return [running, ...ids.filter((id) => id !== running)];
  }

  private wakeAll(): void {
    for (const kind of artifactKinds) {
      this.wake(kind);
    }
  }

  private wake(kind: ArtifactKind): void {
    if (this.running.has(kind) || this.stop.signal.aborted) {
      return;
    }
    const next = this.eligible(kind)[0];
    if (next === undefined) {
      return;
    }
    this.running.set(kind, next.manifest.episodeId);
    void this.runArtifact(kind, next).then(() => {
      this.running.delete(kind);
      this.wakeAll();
    });
  }

  private async retry(entry: EpisodeEntry, kinds: readonly ArtifactKind[]): Promise<StartResult> {
    const id = entry.manifest.episodeId;
    const layout = episodeLayout(this.root, id);
    for (const kind of kinds) {
      const progress = entry.artifacts[kind];
      if (progress.kind === "failed") {
        this.setArtifact(id, kind, { kind: "pending", done: progress.done, total: progress.total });
      }
      await rm(layout.artifacts[kind].failed, { force: true });
    }
    this.wakeAll();
    const current = this.entries.get(id) ?? entry;
    return { kind: "started", created: false, episode: this.present(current) };
  }

  private async create(id: EpisodeId, digest: string, source: string, language: string): Promise<StartResult> {
    const durationMs = await probeDurationMs(source);
    if (durationMs === undefined || durationMs === 0) {
      return rejected("not-audio", `${source} has no decodable audio`);
    }
    const layout = episodeLayout(this.root, id);
    const sourceFile = basename(layout.source(extname(source).toLowerCase()));
    const manifest: EpisodeManifest = {
      episodeId: id,
      sha256: digest,
      sourceName: basename(source),
      sourceFile,
      durationMs,
      enqueuedAt: new Date().toISOString(),
      language,
    };
    const staging = join(
      workspaceDirs(this.root).episodesDir,
      `.staging-${randomBytes(6).toString("hex")}`,
    );
    await mkdir(staging);
    try {
      await linkOrCopy(source, join(staging, sourceFile));
      await writeFile(
        join(staging, basename(layout.manifest)),
        `${JSON.stringify(manifest, null, 2)}\n`,
      );
      await rename(staging, layout.dir);
    } catch (error) {
      await rm(staging, { recursive: true, force: true });
      throw error;
    }
    const plan = planSlices(durationMs);
    const entry: EpisodeEntry = {
      manifest,
      plan,
      artifacts: {
        transcript: { kind: "pending", done: 0, total: plan.length },
        embedding: { kind: "pending", done: 0, total: 0 },
      },
    };
    this.entries.set(id, entry);
    this.wakeAll();
    return { kind: "started", created: true, episode: this.present(entry) };
  }

  /** Never rejects. Every outcome lands in the entry, and on disk unless the queue closed. */
  private async runArtifact(kind: ArtifactKind, entry: EpisodeEntry): Promise<void> {
    const signal = this.stop.signal;
    const id = entry.manifest.episodeId;
    const progress = entry.artifacts[kind];
    let counts = progress.kind === "ready" ? { done: 0, total: 0 } : { done: progress.done, total: progress.total };
    const run: StageRun = {
      entry,
      layout: episodeLayout(this.root, id),
      signal,
      report: (done, total) => {
        counts = { done, total };
        this.setArtifact(id, kind, { kind: "pending", done, total });
      },
    };
    try {
      if (await this.runStage(kind, run)) {
        this.setArtifact(id, kind, { kind: "ready" });
      }
    } catch (error) {
      if (signal.aborted) {
        return;
      }
      await this.fail(id, kind, error, counts.done, counts.total);
    }
  }

  /** True once the output is renamed into place. False when the queue closed first. Throws on failure. */
  private runStage(kind: ArtifactKind, run: StageRun): Promise<boolean> {
    switch (kind) {
      case "transcript":
        return this.transcribe(run);
      case "embedding":
        return this.embed(run);
      default: {
        const leftover: never = kind;
        throw new Error(`unexpected artifact ${String(leftover)}`);
      }
    }
  }

  private async transcribe(run: StageRun): Promise<boolean> {
    const { entry, layout, signal } = run;
    const artifact = layout.artifacts.transcript;
    const source = join(layout.dir, entry.manifest.sourceFile);
    const total = entry.plan.length;
    const model = modelForLanguage(entry.manifest.language);
    if (model === undefined) {
      throw new Error(`unknown language ${entry.manifest.language}`);
    }
    const refusal = transcriptRefusal(model, this.config.modelWeights);
    if (refusal !== undefined) {
      throw new Error(refusal);
    }
    await mkdir(artifact.workDir, { recursive: true });
    const todo = await missingSlices(layout, entry.plan);
    let done = total - todo.length;
    run.report(done, total);
    const outcome = await runLanes(todo, fleetSize(model.id, this.config), signal, async (slice) => {
      const files = sliceFiles(layout, slice.index);
      if (!(await pathExists(files.wavPath))) {
        const cut = await commitFile(files.wavPath, signal, (temp) => cutSlice(source, slice, temp));
        if (!cut) {
          return false;
        }
      }
      const result = await this.hosts.whistle.transcribeSlice({
        sliceIndex: slice.index,
        startMs: slice.startMs,
        wavPath: files.wavPath,
        language: entry.manifest.language,
      });
      const stored = await commitFile(files.whistlePath, signal, (temp) =>
        writeFile(temp, serializeWhistle(result)),
      );
      if (!stored) {
        return false;
      }
      done += 1;
      run.report(done, total);
      return true;
    });
    if (!finished(outcome)) {
      return false;
    }
    const records = await Promise.all(
      entry.plan.map(async (slice): Promise<SliceRecord> => {
        const files = sliceFiles(layout, slice.index);
        const whistle = parseWhistle(JSON.parse(await readFile(files.whistlePath, "utf8")));
        return { plan: slice, slicePath: files.wavPath, whistle };
      }),
    );
    const { vtt } = projectSlices(records);
    return commitFile(artifact.output, signal, (temp) => writeFile(temp, vtt));
  }

  private async embed(run: StageRun): Promise<boolean> {
    const { layout, signal } = run;
    const transcript = await readFile(layout.artifacts.transcript.output, "utf8");
    const stretches = await this.ensureStretchVectors(run, transcript);
    if (stretches === undefined) {
      return false;
    }
    const assignments = assignCues(readVttCues(transcript), stretches);
    return commitFile(layout.groups, signal, (temp) =>
      writeFile(temp, `${JSON.stringify({ cues: assignments }, null, 2)}\n`),
    );
  }

  private async ensureStretchVectors(
    run: StageRun,
    transcript: string,
  ): Promise<readonly StretchVector[] | undefined> {
    const { entry, layout, signal } = run;
    const artifact = layout.artifacts.embedding;
    if (await pathExists(artifact.output)) {
      const stored = readStretchVectors(await readJsonFile(artifact.output));
      if (stored === undefined) {
        throw new Error(`could not read ${artifact.output}`);
      }
      run.report(stored.length, stored.length);
      return stored;
    }
    const source = join(layout.dir, entry.manifest.sourceFile);
    await this.hosts.embed.prepare();
    const stretches = planStretches(readCueSpans(transcript));
    await mkdir(artifact.workDir, { recursive: true });
    const vectors = new Map<number, readonly number[]>();
    run.report(0, stretches.length);
    const outcome = await runLanes(stretches, this.config.embeddingLimit, signal, async (stretch) => {
      const wavPath = stretchWav(layout, stretch.index);
      if (!(await pathExists(wavPath))) {
        const cut = await commitFile(wavPath, signal, (temp) => cutSlice(source, stretch, temp));
        if (!cut) {
          return false;
        }
      }
      vectors.set(stretch.index, await this.hosts.embed.embedStretch(wavPath));
      run.report(vectors.size, stretches.length);
      return true;
    });
    if (!finished(outcome)) {
      return undefined;
    }
    const body = {
      stretches: stretches.map((stretch) => {
        const vector = vectors.get(stretch.index);
        if (vector === undefined) {
          throw new Error(`stretch ${stretch.index} has no vector`);
        }
        return { startMs: stretch.startMs, endMs: stretch.endMs, vector };
      }),
    };
    const wrote = await commitFile(artifact.output, signal, (temp) =>
      writeFile(temp, `${JSON.stringify(body)}\n`),
    );
    return wrote ? body.stretches : undefined;
  }

  private async fail(
    id: EpisodeId,
    kind: ArtifactKind,
    error: unknown,
    done: number,
    total: number,
  ): Promise<void> {
    const message = error instanceof Error ? error.message : String(error);
    const record = `${JSON.stringify({ message, at: new Date().toISOString() }, null, 2)}\n`;
    const artifact = episodeLayout(this.root, id).artifacts[kind];
    const failedPath = artifact.failed;
    try {
      await mkdir(artifact.dir, { recursive: true });
      await commitFile(failedPath, this.stop.signal, (temp) => writeFile(temp, record));
    } catch (writeError) {
      const reason = writeError instanceof Error ? writeError.message : String(writeError);
      console.error(`poddrill: could not write ${failedPath}: ${reason}`);
    }
    this.setArtifact(id, kind, { kind: "failed", message, done, total });
  }
}

type LaneOutcome =
  | { readonly kind: "done" }
  | { readonly kind: "stopped" }
  | { readonly kind: "failed"; readonly error: unknown };

/**
 * Run `work` over `items` with at most `lanes` in flight. Items are taken in order.
 * After the first rejection, a `false`, or an abort, no lane takes a new item, and lanes in flight finish.
 * Resolves only after every lane stops, so once it resolves nothing this stage started can still write.
 */
async function runLanes<T>(
  items: readonly T[],
  lanes: number,
  signal: AbortSignal,
  work: (item: T) => Promise<boolean>,
): Promise<LaneOutcome> {
  let cursor = 0;
  let stopped = false;
  let failure: { readonly error: unknown } | undefined;
  const lane = async (): Promise<void> => {
    while (!signal.aborted && !stopped && failure === undefined) {
      const item = items[cursor];
      if (item === undefined) {
        return;
      }
      cursor += 1;
      try {
        if (!(await work(item))) {
          stopped = true;
        }
      } catch (error) {
        failure ??= { error };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(lanes, items.length) }, lane));
  if (signal.aborted || stopped) {
    return { kind: "stopped" };
  }
  return failure === undefined ? { kind: "done" } : { kind: "failed", error: failure.error };
}

/** True when every lane finished its item. Rethrows the first lane failure. */
function finished(outcome: LaneOutcome): boolean {
  switch (outcome.kind) {
    case "done":
      return true;
    case "stopped":
      return false;
    case "failed":
      throw outcome.error;
    default: {
      const leftover: never = outcome;
      throw new Error(`unexpected lane outcome ${JSON.stringify(leftover)}`);
    }
  }
}

/** Slices with no Whistle JSON yet, in index order. */
async function missingSlices(
  layout: EpisodeLayout,
  plan: readonly PlannedSlice[],
): Promise<readonly PlannedSlice[]> {
  const missing: PlannedSlice[] = [];
  for (const slice of plan) {
    if (!(await pathExists(sliceFiles(layout, slice.index).whistlePath))) {
      missing.push(slice);
    }
  }
  return missing;
}

/**
 * Dedupe first, then capacity. Capacity counts pending transcripts plus `admitting`.
 * A failed transcript must pass capacity to retry. A failed embedding retries without it.
 */
function admit(
  entries: ReadonlyMap<EpisodeId, EpisodeEntry>,
  unfinished: readonly EpisodeId[],
  admittingCount: number,
  queueLength: number,
  id: EpisodeId,
): Admission {
  const full = unfinished.length + admittingCount >= queueLength;
  const existing = entries.get(id);
  if (existing === undefined) {
    return full ? { kind: "full", unfinished } : { kind: "admit" };
  }
  const failed = artifactKinds.filter((kind) => existing.artifacts[kind].kind === "failed");
  if (failed.length === 0) {
    return { kind: "existing", entry: existing };
  }
  if (failed.includes("transcript") && full) {
    return { kind: "full", unfinished };
  }
  return { kind: "retry", entry: existing, kinds: failed };
}

function compareText(a: string, b: string): number {
  if (a === b) {
    return 0;
  }
  return a < b ? -1 : 1;
}

function shownProgress(done: number, total: number): number {
  if (total === 0) {
    return 0;
  }
  return Math.min(99, Math.floor((done / total) * 100));
}

/** `position` counts only queued episodes ahead for this kind, so the next to run is 1. */
function artifactState(
  entry: EpisodeEntry,
  kind: ArtifactKind,
  layout: ArtifactLayout,
  order: readonly EpisodeId[],
  running: EpisodeId | undefined,
): ArtifactState {
  const id = entry.manifest.episodeId;
  const progress = entry.artifacts[kind];
  switch (progress.kind) {
    case "ready":
      return { state: "ready", progress: 100, path: layout.output };
    case "failed":
      return {
        state: "failed",
        progress: shownProgress(progress.done, progress.total),
        message: progress.message,
      };
    case "pending": {
      const dependency = DEPENDS_ON[kind];
      if (dependency !== undefined && entry.artifacts[dependency].kind !== "ready") {
        return { state: "waiting", on: dependency };
      }
      const shown = shownProgress(progress.done, progress.total);
      if (id === running) {
        return { state: "running", progress: shown };
      }
      const queued = order.filter((other) => other !== running);
      return { state: "queued", position: queued.indexOf(id) + 1, progress: shown };
    }
    default: {
      const leftover: never = progress;
      throw new Error(`unexpected artifact progress ${JSON.stringify(leftover)}`);
    }
  }
}

async function loadEpisodes(root: WorkspaceRoot): Promise<readonly EpisodeEntry[]> {
  const { episodesDir } = workspaceDirs(root);
  await mkdir(episodesDir, { recursive: true });
  const entries: EpisodeEntry[] = [];
  for (const dirent of await readdir(episodesDir, { withFileTypes: true })) {
    if (dirent.name.startsWith(".staging-")) {
      await rm(join(episodesDir, dirent.name), { recursive: true, force: true });
      continue;
    }
    const id = parseEpisodeId(dirent.name);
    if (id === undefined || !dirent.isDirectory()) {
      continue;
    }
    const entry = await loadEpisode(root, id);
    if (entry === undefined) {
      console.error(`poddrill: ignoring ${join(episodesDir, dirent.name)}: episode.json is malformed`);
      continue;
    }
    entries.push(entry);
  }
  return entries;
}

function presentSummary(episodeId: EpisodeId, document: SummaryDocument): SummaryRead {
  return {
    state: "present",
    episodeId,
    version: 1,
    summaryId: document.summaryId,
    summary: document.summary,
    paragraphs: document.paragraphs,
  };
}

async function loadSummaryHeads(layout: EpisodeLayout, episodeId: EpisodeId): Promise<readonly SummaryHead[]> {
  await removeTempFiles(layout.summaries);
  let names: string[];
  try {
    names = await readdir(layout.summaries);
  } catch (error) {
    if (errorCode(error) === "ENOENT") {
      return [];
    }
    throw error;
  }
  const heads: SummaryHead[] = [];
  for (const name of names) {
    if (!name.endsWith(".yaml")) {
      continue;
    }
    const summaryId = parseSummaryId(name.slice(0, -".yaml".length));
    if (summaryId === undefined) {
      continue;
    }
    let text: string;
    try {
      text = await readFile(layout.summaryFile(summaryId), "utf8");
    } catch {
      continue;
    }
    const document = parseSummaryFile(text, episodeId, summaryId);
    if (document === undefined) {
      continue;
    }
    heads.push({ summaryId: document.summaryId });
  }
  heads.sort((left, right) => compareText(left.summaryId, right.summaryId));
  return heads;
}

async function loadEpisode(root: WorkspaceRoot, id: EpisodeId): Promise<EpisodeEntry | undefined> {
  const layout = episodeLayout(root, id);
  await removeTempFiles(layout.dir);
  for (const kind of artifactKinds) {
    await removeTempFiles(layout.artifacts[kind].dir);
    await removeTempFiles(layout.artifacts[kind].workDir);
  }
  const manifest = parseManifest(await readJsonFile(layout.manifest), id);
  if (manifest === undefined) {
    return undefined;
  }
  const plan = planSlices(manifest.durationMs);
  let slicesDone = 0;
  for (const slice of plan) {
    if (await pathExists(sliceFiles(layout, slice.index).whistlePath)) {
      slicesDone += 1;
    }
  }
  return {
    manifest,
    plan,
    artifacts: {
      transcript: await readArtifact(layout.artifacts.transcript, slicesDone, plan.length),
      // Vectors live only in the output, so a restarted embedding counts from 0.
      embedding: await readArtifact(layout.artifacts.embedding, 0, 0, layout.groups),
    },
  };
}

async function readArtifact(
  layout: ArtifactLayout,
  done: number,
  total: number,
  companion?: string,
): Promise<ArtifactProgress> {
  const outputReady = await pathExists(layout.output);
  const companionReady = companion === undefined || (await pathExists(companion));
  if (outputReady && companionReady) {
    return { kind: "ready" };
  }
  if (!outputReady && (await pathExists(layout.failed))) {
    const message = asRecord(await readJsonFile(layout.failed))?.["message"];
    return {
      kind: "failed",
      message: typeof message === "string" ? message : "failed.json is unreadable",
      done,
      total,
    };
  }
  return { kind: "pending", done, total };
}

/** A malformed manifest makes the dir invisible. */
function parseManifest(value: unknown, id: EpisodeId): EpisodeManifest | undefined {
  const record = asRecord(value);
  if (record === undefined) {
    return undefined;
  }
  const { episodeId, sha256, sourceName, sourceFile, durationMs, enqueuedAt } = record;
  if (
    episodeId !== id ||
    typeof sha256 !== "string" ||
    typeof sourceName !== "string" ||
    typeof sourceFile !== "string" ||
    basename(sourceFile) !== sourceFile ||
    typeof durationMs !== "number" ||
    !Number.isInteger(durationMs) ||
    durationMs < 1 ||
    typeof enqueuedAt !== "string"
  ) {
    return undefined;
  }
  const language = record["language"] === undefined ? "en" : record["language"];
  if (typeof language !== "string" || language === "") {
    return undefined;
  }
  return { episodeId: id, sha256, sourceName, sourceFile, durationMs, enqueuedAt, language };
}

async function removeTempFiles(dir: string): Promise<void> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch (error) {
    if (errorCode(error) === "ENOENT") {
      return;
    }
    throw error;
  }
  for (const name of names) {
    if (name.endsWith(".tmp")) {
      await rm(join(dir, name), { force: true });
    }
  }
}

/** Relative paths resolve against the workspace root, because the owner's cwd is not the caller's. */
async function locateAudio(
  root: WorkspaceRoot,
  audioPath: string,
): Promise<{ readonly kind: "located"; readonly path: string } | Rejected> {
  const { audioDir } = workspaceDirs(root);
  const requested = resolve(root, audioPath);
  let real: string;
  try {
    real = await realpath(requested);
  } catch (error) {
    if (errorCode(error) === "ENOENT") {
      return rejected("not-found", `${requested} does not exist`);
    }
    throw error;
  }
  const inside = relative(await realpath(audioDir), real);
  if (inside === "" || inside === ".." || inside.startsWith(`..${sep}`) || isAbsolute(inside)) {
    return rejected(
      "outside-audio-dir",
      `${requested} is not under ${audioDir}. Save the episode audio there first.`,
    );
  }
  if (!(await stat(real)).isFile()) {
    return rejected("not-found", `${requested} is not a file`);
  }
  return { kind: "located", path: real };
}

function rejected(reason: StartRejection, message: string): Rejected {
  return { kind: "rejected", reason, message };
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk);
  }
  return hash.digest("hex");
}

async function linkOrCopy(from: string, to: string): Promise<void> {
  try {
    await link(from, to);
  } catch (error) {
    if (errorCode(error) !== "EXDEV") {
      throw error;
    }
    await copyFile(from, to);
  }
}

function resolveLimit(
  limit: number | undefined,
): number | { readonly kind: "rejected"; readonly reason: "limit"; readonly message: string } {
  if (limit === undefined) {
    return 8;
  }
  if (!Number.isInteger(limit) || limit < 1 || limit > 20) {
    return {
      kind: "rejected",
      reason: "limit",
      message: "limit must be an integer from 1 through 20",
    };
  }
  return limit;
}

async function readStoredRows(layout: EpisodeLayout): Promise<StoredRows> {
  let vtt: string;
  try {
    vtt = await readFile(layout.artifacts.transcript.output, "utf8");
  } catch (error) {
    if (errorCode(error) === "ENOENT") {
      return { kind: "unreadable" };
    }
    throw error;
  }
  const cues = readVttCues(vtt);
  if (!(await pathExists(layout.groups))) {
    return { kind: "missing-groups" };
  }
  const stored = readAssignments(await readJsonFile(layout.groups));
  return stored === undefined ? { kind: "unreadable" } : { kind: "rows", rows: cueRows(cues, stored) };
}

async function readStoredLabels(path: string): Promise<readonly StoredLabel[] | undefined> {
  if (!(await pathExists(path))) {
    return [];
  }
  return readLabels(await readJsonFile(path));
}

/**
 * Write through a temp file, then rename. Returns false without renaming once the queue closed,
 * so a closed queue leaves the same files a crash would.
 */
async function commitFile(
  target: string,
  signal: AbortSignal,
  write: (tempPath: string) => Promise<void>,
): Promise<boolean> {
  const temp = `${target}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    await write(temp);
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }
  if (signal.aborted) {
    await rm(temp, { force: true });
    return false;
  }
  await rename(temp, target);
  return true;
}
