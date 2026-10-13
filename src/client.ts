import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { cp, mkdir, readdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, normalize, relative } from "node:path";

import { asRecord, errorCode, pathExists } from "./disk.ts";
import { embedWeightsPath } from "./embed.ts";
import { readPackageIdentity, type PackageIdentity } from "./package-identity.ts";

const serverName = "poddrill";

const skillPublishPath = `.agents/skills/${serverName}`;
const skillNextPrefix = `${serverName}.next-`;
const skillPrevPrefix = `${serverName}.prev-`;
const skillMarkerSuffix = ".complete";

const requiredPublishedFiles = ["dist", skillPublishPath] as const;

const GROK_STARTUP_TIMEOUT_SEC = 30;

const CONFIG_CAS_LIMIT = 5;

const clientIds = ["cursor", "grok_build", "grok_bot"] as const;

type ClientId = (typeof clientIds)[number];

type WritingClient = "cursor" | "grok_build";

type PoddrillSpec = PackageIdentity["spec"];

type ClientOp = "doctor" | "plan" | "apply";

interface Launcher {
  readonly command: "npx";
  readonly args: readonly ["-y", PoddrillSpec, "mcp"];
}

type ClientSelection =
  | { readonly kind: "one"; readonly client: ClientId }
  | { readonly kind: "linked" };

type ClientCommand =
  | { readonly op: "doctor"; readonly client: ClientId }
  | { readonly op: "plan"; readonly selection: ClientSelection }
  | { readonly op: "apply"; readonly selection: ClientSelection };

type PreviousEntry =
  | { readonly command: string; readonly args: readonly string[] }
  | {
      readonly command: string;
      readonly args: readonly string[];
      readonly startupTimeoutSec: number | null;
    };

type ServerRecord =
  | { readonly status: "absent" }
  | { readonly status: "match" }
  | { readonly status: "differ"; readonly previous: PreviousEntry }
  | { readonly status: "unreadable"; readonly detail: string };

type CursorEffect = {
  readonly client: "cursor";
  readonly path: string;
  readonly record: ServerRecord;
};

type GrokEffect = {
  readonly client: "grok_build";
  readonly path: string;
  readonly record: ServerRecord;
  readonly startupTimeoutSec: typeof GROK_STARTUP_TIMEOUT_SEC;
};

type GrokBotEffect = {
  readonly client: "grok_bot";
  readonly sentence: string;
};

type ClientEffect = CursorEffect | GrokEffect | GrokBotEffect;

type SkillAction = "keep" | "install" | "replace" | "finish";

type SkillIntent = {
  readonly dest: string;
  readonly action: SkillAction;
};

interface SkillView {
  readonly live: "absent" | "match" | "differ";
  readonly partialNext: readonly string[];
  readonly completeNext: readonly string[];
  readonly prev: readonly string[];
  readonly orphanMarkers: readonly string[];
}

type SkillStep =
  | { readonly op: "done" }
  | { readonly op: "drop"; readonly path: string }
  | { readonly op: "stage" }
  | { readonly op: "promote"; readonly path: string }
  | { readonly op: "aside" };

type ClientPlan = {
  readonly kind: "plan";
  readonly launcher: Launcher;
  readonly skill: SkillIntent;
  readonly effects: readonly ClientEffect[];
};

type NothingLinked = {
  readonly kind: "nothing-linked";
  readonly launcher: Launcher;
};

type MergeResult = "unchanged" | "written";

type AppliedEffect =
  | { readonly client: "cursor"; readonly path: string; readonly result: MergeResult }
  | {
      readonly client: "grok_build";
      readonly path: string;
      readonly result: MergeResult;
      readonly startupTimeoutSec: typeof GROK_STARTUP_TIMEOUT_SEC;
    }
  | { readonly client: "grok_bot"; readonly sentence: string };

type Applied = {
  readonly kind: "applied";
  readonly launcher: Launcher;
  readonly skill: SkillAction;
  readonly results: readonly AppliedEffect[];
};

type DoctorCheck =
  | { readonly name: "skill-bundle"; readonly state: "ok" }
  | { readonly name: "skill-bundle"; readonly state: "bad"; readonly detail: string }
  | { readonly name: "ffmpeg"; readonly state: "ok" }
  | { readonly name: "ffmpeg"; readonly state: "bad"; readonly detail: string }
  | { readonly name: "cactus-needle"; readonly state: "ok"; readonly version: string }
  | {
      readonly name: "cactus-needle";
      readonly state: "bad";
      readonly expected: string;
      readonly found: string | undefined;
    }
  | { readonly name: "ecapa"; readonly state: "ok"; readonly path: string }
  | { readonly name: "ecapa"; readonly state: "bad"; readonly path: string }
  | { readonly name: "link"; readonly client: WritingClient; readonly record: ServerRecord }
  | { readonly name: "link"; readonly client: "grok_bot"; readonly sentence: string };

type DoctorReport = {
  readonly kind: "doctor";
  readonly client: ClientId;
  readonly launcher: Launcher;
  readonly checks: readonly DoctorCheck[];
};

type ClientRefusal =
  | {
      readonly kind: "refused";
      readonly reason: "home-missing" | "package-identity" | "config-race" | "skill-mismatch";
      readonly message: string;
    }
  | {
      readonly kind: "refused";
      readonly reason: "unreadable-config" | "outside-home" | "skill-bundle-missing" | "skill-pin-mismatch";
      readonly message: string;
      readonly path: string;
    };

type ClientOutcome = ClientPlan | Applied | NothingLinked | DoctorReport | ClientRefusal;

type RuntimeReport = readonly [
  Extract<DoctorCheck, { readonly name: "ffmpeg" }>,
  Extract<DoctorCheck, { readonly name: "cactus-needle" }>,
  Extract<DoctorCheck, { readonly name: "ecapa" }>,
];

interface ClientPaths {
  readonly skillDest: string;
  readonly cursorMcp: string;
  readonly grokConfig: string;
}

interface Rendered {
  readonly text: string;
  readonly exitCode: 0 | 1;
}

interface ErrorBody {
  readonly kind: "error";
  readonly message: string;
}

type ParsedArgs =
  | { readonly ok: true; readonly command: ClientCommand }
  | { readonly ok: false; readonly message: string };

interface ProbeResult {
  readonly code: number | null;
  readonly stdout: string;
}

interface TomlSection {
  readonly headerStart: number;
  readonly bodyEnd: number;
  readonly name: string;
  readonly body: string;
}

const clientIdList = clientIds.join("|");

export const clientUsageBody = [
  `client doctor --client <${clientIdList}> [--json]`,
  `client plan --client <${clientIdList}> [--json]`,
  `client plan --linked [--json]`,
  `client apply --yes --client <${clientIdList}> [--json]`,
  `client apply --yes --linked [--json]`,
].join(" | ");

const clientUsage = `usage: poddrill ${clientUsageBody}`;

const workspaceCommandMessage =
  "poddrill client registers Cursor or Grok. A workspace is poddrill setup --provider <id> --queue-length <n>.";

export function workspaceSetupCollision(args: readonly string[]): string | undefined {
  for (const flag of ["--client", "--linked", "--yes", "--dry-run"] as const) {
    if (args.includes(flag)) {
      return `poddrill setup writes a workspace. Register a client with: ${clientUsage}`;
    }
  }
  return undefined;
}

export async function clientMain(
  args: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
  moduleUrl: string,
): Promise<Rendered> {
  const parsed = parseClientArgs(args);
  if (!parsed.ok) {
    return { text: errorText(parsed.message), exitCode: 1 };
  }
  const home = absoluteHome(env);
  if (home === undefined) {
    return outcomeRendered({
      kind: "refused",
      reason: "home-missing",
      message: "HOME must be an absolute path",
    });
  }
  const identity = await readPackageIdentity(moduleUrl);
  if (!publishLayoutOk(identity.files)) {
    return outcomeRendered({
      kind: "refused",
      reason: "package-identity",
      message: `package.json files must include ${requiredPublishedFiles.join(" and ")}`,
    });
  }
  switch (parsed.command.op) {
    case "doctor":
      return outcomeRendered(await doctor(parsed.command.client, identity, home, env));
    case "plan":
      return outcomeRendered(await resolve(parsed.command.selection, identity, home));
    case "apply":
      return outcomeRendered(
        await applyResolved(await resolve(parsed.command.selection, identity, home), identity, home),
      );
    default: {
      const leftover: never = parsed.command;
      throw new Error(`unexpected command ${JSON.stringify(leftover)}`);
    }
  }
}

async function doctor(
  client: ClientId,
  identity: PackageIdentity,
  home: string,
  env: Readonly<Record<string, string | undefined>>,
): Promise<DoctorReport> {
  const launcher = launcherFor(identity.spec);
  const paths = pathsFor(home);
  const skillText = await readOptionalUtf8(join(identity.root, skillPublishPath, "SKILL.md"));
  const probes = await runtimeProbes(env, identity);
  const link = await linkCheckFor(client, paths, launcher);
  return {
    kind: "doctor",
    client,
    launcher,
    checks: [skillBundleCheck(skillText), probes[0], probes[1], probes[2], link],
  };
}

async function resolve(
  selection: ClientSelection,
  identity: PackageIdentity,
  home: string,
): Promise<ClientPlan | NothingLinked | ClientRefusal> {
  const launcher = launcherFor(identity.spec);
  const skillPath = join(identity.root, skillPublishPath, "SKILL.md");
  const skillText = await readOptionalUtf8(skillPath);
  if (skillText === undefined) {
    return {
      kind: "refused",
      reason: "skill-bundle-missing",
      path: skillPath,
      message: `bundled skill is missing at ${skillPath}`,
    };
  }
  if (!skillAgrees(skillText)) {
    return {
      kind: "refused",
      reason: "skill-pin-mismatch",
      path: skillPath,
      message:
        "bundled skill must name client doctor, client plan, and client apply --yes, and must not include @latest or an unpinned npx launch",
    };
  }
  const paths = pathsFor(home);
  const effects = await effectsFor(selection, launcher, paths);
  if (effects === undefined) {
    return { kind: "nothing-linked", launcher };
  }
  const bundle = bundleDir(identity);
  const view = await observeSkill(paths.skillDest, bundle);
  return {
    kind: "plan",
    launcher,
    skill: { dest: paths.skillDest, action: skillAction(view) },
    effects,
  };
}

async function applyResolved(
  resolved: ClientPlan | NothingLinked | ClientRefusal,
  identity: PackageIdentity,
  home: string,
): Promise<ClientOutcome> {
  switch (resolved.kind) {
    case "nothing-linked":
    case "refused":
      return resolved;
    case "plan":
      return commit(resolved, identity, home);
    default: {
      const leftover: never = resolved;
      throw new Error(`unexpected resolution ${JSON.stringify(leftover)}`);
    }
  }
}

async function commit(
  plan: ClientPlan,
  identity: PackageIdentity,
  home: string,
): Promise<Applied | ClientRefusal> {
  const blocked = firstUnreadable(plan.effects);
  if (blocked !== undefined) {
    return blocked;
  }
  if (!(await staysInHome(home, plan.skill.dest))) {
    return {
      kind: "refused",
      reason: "outside-home",
      path: plan.skill.dest,
      message: `refusing to write ${plan.skill.dest}`,
    };
  }
  const skillError = await convergeSkill(plan.skill.dest, bundleDir(identity));
  if (skillError !== undefined) {
    return skillError;
  }
  const results: AppliedEffect[] = [];
  for (const effect of plan.effects) {
    const written = await writeEffect(effect, plan.launcher, home);
    if ("kind" in written) {
      return written;
    }
    results.push(written);
  }
  const verified = await verify(plan, identity);
  if (verified !== undefined) {
    return verified;
  }
  return {
    kind: "applied",
    launcher: plan.launcher,
    skill: plan.skill.action,
    results,
  };
}

function parseClientArgs(args: readonly string[]): ParsedArgs {
  const opText = args[0];
  if (opText === undefined) {
    return fail(clientUsage);
  }
  const op = parseOp(opText);
  if (op === undefined) {
    return fail(clientUsage);
  }
  let jsonCount = 0;
  let yes = false;
  let linked = false;
  let client: ClientId | undefined;
  for (let index = 1; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === undefined) {
      continue;
    }
    if (arg === "--provider" || arg === "--queue-length") {
      return fail(workspaceCommandMessage);
    }
    switch (arg) {
      case "--json":
        jsonCount += 1;
        if (jsonCount > 1) {
          return fail(clientUsage);
        }
        break;
      case "--yes":
        if (yes) {
          return fail(clientUsage);
        }
        yes = true;
        break;
      case "--linked":
        if (linked) {
          return fail(clientUsage);
        }
        linked = true;
        break;
      case "--dry-run":
        return fail("client plan is the preview. poddrill client has no --dry-run flag.");
      case "--client": {
        if (client !== undefined) {
          return fail(clientUsage);
        }
        const value = args[index + 1];
        if (value === undefined || value.startsWith("--")) {
          return fail(clientUsage);
        }
        const parsed = parseClientId(value);
        if (parsed === undefined) {
          return fail(clientUsage);
        }
        client = parsed;
        index += 1;
        break;
      }
      default:
        return fail(clientUsage);
    }
  }
  if (yes && op !== "apply") {
    return fail("client plan does not write. client apply --yes writes.");
  }
  if (!yes && op === "apply") {
    return fail("client apply writes nothing without --yes. client plan previews.");
  }
  const command = commandFrom(op, client, linked);
  if (command === undefined) {
    return fail(clientUsage);
  }
  return { ok: true, command };
}

function commandFrom(op: ClientOp, client: ClientId | undefined, linked: boolean): ClientCommand | undefined {
  if (linked && client !== undefined) {
    return undefined;
  }
  switch (op) {
    case "doctor":
      if (linked || client === undefined) {
        return undefined;
      }
      return { op: "doctor", client };
    case "plan":
      if (linked) {
        return { op: "plan", selection: { kind: "linked" } };
      }
      if (client === undefined) {
        return undefined;
      }
      return { op: "plan", selection: { kind: "one", client } };
    case "apply":
      if (linked) {
        return { op: "apply", selection: { kind: "linked" } };
      }
      if (client === undefined) {
        return undefined;
      }
      return { op: "apply", selection: { kind: "one", client } };
    default: {
      const leftover: never = op;
      throw new Error(`unexpected op ${String(leftover)}`);
    }
  }
}

function parseOp(value: string): ClientOp | undefined {
  switch (value) {
    case "doctor":
    case "plan":
    case "apply":
      return value;
    default:
      return undefined;
  }
}

function parseClientId(value: string): ClientId | undefined {
  for (const client of clientIds) {
    if (client === value) {
      return client;
    }
  }
  return undefined;
}

function fail(message: string): ParsedArgs {
  return { ok: false, message };
}

function absoluteHome(env: Readonly<Record<string, string | undefined>>): string | undefined {
  const raw = env["HOME"];
  const home = raw === undefined || raw === "" ? homedir() : raw;
  if (!isAbsolute(home)) {
    return undefined;
  }
  return home;
}

function publishLayoutOk(files: readonly string[]): boolean {
  for (const required of requiredPublishedFiles) {
    if (!files.includes(required)) {
      return false;
    }
  }
  return true;
}

function launcherFor(spec: PoddrillSpec): Launcher {
  return { command: "npx", args: ["-y", spec, "mcp"] };
}

function bundleDir(identity: PackageIdentity): string {
  return join(identity.root, skillPublishPath);
}

function grokBotSentence(launcher: Launcher): string {
  const commandLine = [launcher.command, ...launcher.args].join(" ");
  return `Add a custom server named ${serverName} on this computer, running ${commandLine}.`;
}

function skillAgrees(skillText: string): boolean {
  if (skillText.includes(`${serverName}@latest`) || skillText.includes(`npx -y ${serverName} `)) {
    return false;
  }
  return (
    skillText.includes("client doctor") &&
    skillText.includes("client plan") &&
    skillText.includes("client apply --yes")
  );
}

function skillBundleCheck(text: string | undefined): DoctorCheck {
  if (text !== undefined && skillAgrees(text)) {
    return { name: "skill-bundle", state: "ok" };
  }
  const detail =
    text === undefined
      ? "bundled SKILL.md is missing"
      : "bundled SKILL.md does not name the client commands";
  return { name: "skill-bundle", state: "bad", detail };
}

function writingClients(): readonly WritingClient[] {
  const found: WritingClient[] = [];
  for (const client of clientIds) {
    switch (client) {
      case "cursor":
      case "grok_build":
        found.push(client);
        break;
      case "grok_bot":
        break;
      default: {
        const leftover: never = client;
        throw new Error(`unexpected client ${String(leftover)}`);
      }
    }
  }
  return found;
}

function pathsFor(home: string): ClientPaths {
  return {
    skillDest: join(home, skillPublishPath),
    cursorMcp: join(home, ".cursor", "mcp.json"),
    grokConfig: join(home, ".grok", "config.toml"),
  };
}

function configFormat(client: WritingClient): "json" | "toml" {
  switch (client) {
    case "cursor":
      return "json";
    case "grok_build":
      return "toml";
    default: {
      const leftover: never = client;
      throw new Error(`unexpected writer ${String(leftover)}`);
    }
  }
}

function skillAction(view: SkillView): SkillAction {
  switch (view.live) {
    case "match":
      return "keep";
    case "absent":
      return view.completeNext.length > 0 ? "finish" : "install";
    case "differ":
      return "replace";
    default: {
      const leftover: never = view.live;
      throw new Error(`unexpected live ${String(leftover)}`);
    }
  }
}

function nextSkillStep(view: SkillView): SkillStep {
  const partial = view.partialNext[0];
  if (partial !== undefined) {
    return { op: "drop", path: partial };
  }
  const orphan = view.orphanMarkers[0];
  if (orphan !== undefined) {
    return { op: "drop", path: orphan };
  }
  switch (view.live) {
    case "match": {
      const extra = view.completeNext[0] ?? view.prev[0];
      if (extra !== undefined) {
        return { op: "drop", path: extra };
      }
      return { op: "done" };
    }
    case "absent": {
      const ready = view.completeNext[0];
      if (ready !== undefined) {
        return { op: "promote", path: ready };
      }
      return { op: "stage" };
    }
    case "differ":
      if (view.completeNext[0] === undefined) {
        return { op: "stage" };
      }
      return { op: "aside" };
    default: {
      const leftover: never = view.live;
      throw new Error(`unexpected live ${String(leftover)}`);
    }
  }
}

function skillStepBudget(view: SkillView): number {
  const listed =
    view.partialNext.length +
    view.completeNext.length +
    view.prev.length +
    view.orphanMarkers.length;
  switch (view.live) {
    case "match":
      return listed;
    case "absent":
      return listed + (view.completeNext.length === 0 ? 1 : 0) + 2;
    case "differ":
      return listed + (view.completeNext.length === 0 ? 1 : 0) + 4;
    default: {
      const leftover: never = view.live;
      throw new Error(`unexpected live ${String(leftover)}`);
    }
  }
}

function pathStaysInHome(home: string, candidate: string): boolean {
  const root = normalize(home);
  const target = normalize(candidate);
  const rootPrefix = root.endsWith("/") ? root : `${root}/`;
  return target === root || target.startsWith(rootPrefix);
}

function markerPath(dir: string): string {
  return `${dir}${skillMarkerSuffix}`;
}

function firstUnreadable(effects: readonly ClientEffect[]): ClientRefusal | undefined {
  for (const effect of effects) {
    const refusal = unreadable(effect);
    if (refusal !== undefined) {
      return refusal;
    }
  }
  return undefined;
}

function unreadable(effect: ClientEffect): ClientRefusal | undefined {
  switch (effect.client) {
    case "grok_bot":
      return undefined;
    case "cursor":
    case "grok_build":
      if (effect.record.status !== "unreadable") {
        return undefined;
      }
      return {
        kind: "refused",
        reason: "unreadable-config",
        path: effect.path,
        message: effect.record.detail,
      };
    default: {
      const leftover: never = effect;
      throw new Error(`unexpected effect ${JSON.stringify(leftover)}`);
    }
  }
}

function unchangedEffect(effect: CursorEffect | GrokEffect): AppliedEffect {
  switch (effect.client) {
    case "cursor":
      return { client: "cursor", path: effect.path, result: "unchanged" };
    case "grok_build":
      return {
        client: "grok_build",
        path: effect.path,
        result: "unchanged",
        startupTimeoutSec: effect.startupTimeoutSec,
      };
    default: {
      const leftover: never = effect;
      throw new Error(`unexpected effect ${JSON.stringify(leftover)}`);
    }
  }
}

async function effectsFor(
  selection: ClientSelection,
  launcher: Launcher,
  paths: ClientPaths,
): Promise<readonly ClientEffect[] | undefined> {
  switch (selection.kind) {
    case "one":
      return [await oneEffect(selection.client, launcher, paths)];
    case "linked": {
      const effects: Array<CursorEffect | GrokEffect> = [];
      for (const client of writingClients()) {
        const effect = await writingEffect(client, launcher, paths);
        if (effect.record.status === "absent") {
          continue;
        }
        effects.push(effect);
      }
      if (effects.length === 0) {
        return undefined;
      }
      return effects;
    }
    default: {
      const leftover: never = selection;
      throw new Error(`unexpected selection ${JSON.stringify(leftover)}`);
    }
  }
}

async function oneEffect(client: ClientId, launcher: Launcher, paths: ClientPaths): Promise<ClientEffect> {
  switch (client) {
    case "cursor":
    case "grok_build":
      return writingEffect(client, launcher, paths);
    case "grok_bot":
      return { client: "grok_bot", sentence: grokBotSentence(launcher) };
    default: {
      const leftover: never = client;
      throw new Error(`unexpected client ${String(leftover)}`);
    }
  }
}

async function writingEffect(
  client: WritingClient,
  launcher: Launcher,
  paths: ClientPaths,
): Promise<CursorEffect | GrokEffect> {
  switch (client) {
    case "cursor":
      return {
        client,
        path: paths.cursorMcp,
        record: await linkRecord(paths.cursorMcp, "json", launcher),
      };
    case "grok_build":
      return {
        client,
        path: paths.grokConfig,
        record: await linkRecord(paths.grokConfig, "toml", launcher),
        startupTimeoutSec: GROK_STARTUP_TIMEOUT_SEC,
      };
    default: {
      const leftover: never = client;
      throw new Error(`unexpected writer ${String(leftover)}`);
    }
  }
}

async function linkCheckFor(client: ClientId, paths: ClientPaths, launcher: Launcher): Promise<DoctorCheck> {
  switch (client) {
    case "grok_bot":
      return { name: "link", client, sentence: grokBotSentence(launcher) };
    case "cursor":
    case "grok_build": {
      const effect = await writingEffect(client, launcher, paths);
      return { name: "link", client, record: effect.record };
    }
    default: {
      const leftover: never = client;
      throw new Error(`unexpected client ${String(leftover)}`);
    }
  }
}

async function convergeSkill(dest: string, bundle: string): Promise<ClientRefusal | undefined> {
  let view = await observeSkill(dest, bundle);
  const budget = skillStepBudget(view);
  for (let step = 0; step < budget; step += 1) {
    const next = nextSkillStep(view);
    if (next.op === "done") {
      return undefined;
    }
    await runSkillStep(dest, bundle, next);
    view = await observeSkill(dest, bundle);
  }
  if (nextSkillStep(view).op === "done") {
    return undefined;
  }
  return {
    kind: "refused",
    reason: "skill-mismatch",
    message: `skill at ${dest} did not match the bundle`,
  };
}

async function verify(plan: ClientPlan, identity: PackageIdentity): Promise<ClientRefusal | undefined> {
  const view = await observeSkill(plan.skill.dest, bundleDir(identity));
  if (
    view.live !== "match" ||
    view.partialNext.length > 0 ||
    view.completeNext.length > 0 ||
    view.prev.length > 0 ||
    view.orphanMarkers.length > 0
  ) {
    return {
      kind: "refused",
      reason: "skill-mismatch",
      message: `skill at ${plan.skill.dest} does not match the bundle`,
    };
  }
  for (const effect of plan.effects) {
    switch (effect.client) {
      case "grok_bot":
        break;
      case "cursor":
      case "grok_build": {
        const record = await linkRecord(effect.path, configFormat(effect.client), plan.launcher);
        if (record.status !== "match") {
          return {
            kind: "refused",
            reason: "config-race",
            message: `${effect.path} does not match the launcher`,
          };
        }
        break;
      }
      default: {
        const leftover: never = effect;
        throw new Error(`unexpected effect ${JSON.stringify(leftover)}`);
      }
    }
  }
  return undefined;
}

async function writeEffect(
  effect: ClientEffect,
  launcher: Launcher,
  home: string,
): Promise<AppliedEffect | ClientRefusal> {
  switch (effect.client) {
    case "grok_bot":
      return { client: "grok_bot", sentence: effect.sentence };
    case "cursor":
    case "grok_build": {
      if (!(await staysInHome(home, effect.path))) {
        return {
          kind: "refused",
          reason: "outside-home",
          path: effect.path,
          message: `refusing to write ${effect.path}`,
        };
      }
      if (effect.record.status === "match") {
        return unchangedEffect(effect);
      }
      const swapped = await compareAndSwap(effect.path, configFormat(effect.client), launcher);
      if (typeof swapped !== "string") {
        return swapped;
      }
      return swapped === "unchanged" ? unchangedEffect(effect) : writtenEffect(effect);
    }
    default: {
      const leftover: never = effect;
      throw new Error(`unexpected effect ${JSON.stringify(leftover)}`);
    }
  }
}

function writtenEffect(effect: CursorEffect | GrokEffect): AppliedEffect {
  switch (effect.client) {
    case "cursor":
      return { client: "cursor", path: effect.path, result: "written" };
    case "grok_build":
      return {
        client: "grok_build",
        path: effect.path,
        result: "written",
        startupTimeoutSec: effect.startupTimeoutSec,
      };
    default: {
      const leftover: never = effect;
      throw new Error(`unexpected effect ${JSON.stringify(leftover)}`);
    }
  }
}

function checkFailed(check: DoctorCheck): boolean {
  switch (check.name) {
    case "skill-bundle":
    case "ffmpeg":
    case "cactus-needle":
    case "ecapa":
      return check.state === "bad";
    case "link":
      return linkFailed(check);
    default: {
      const leftover: never = check;
      throw new Error(`unexpected check ${JSON.stringify(leftover)}`);
    }
  }
}

function linkFailed(check: Extract<DoctorCheck, { readonly name: "link" }>): boolean {
  switch (check.client) {
    case "grok_bot":
      return false;
    case "cursor":
    case "grok_build":
      return check.record.status !== "match";
    default: {
      const leftover: never = check;
      throw new Error(`unexpected link ${JSON.stringify(leftover)}`);
    }
  }
}

function exitCode(outcome: ClientOutcome): 0 | 1 {
  switch (outcome.kind) {
    case "plan":
    case "applied":
    case "nothing-linked":
      return 0;
    case "refused":
      return 1;
    case "doctor":
      return outcome.checks.some((check) => checkFailed(check)) ? 1 : 0;
    default: {
      const leftover: never = outcome;
      throw new Error(`unexpected outcome ${JSON.stringify(leftover)}`);
    }
  }
}

function outcomeRendered(outcome: ClientOutcome): Rendered {
  return { text: `${JSON.stringify(outcome)}\n`, exitCode: exitCode(outcome) };
}

function errorText(message: string): string {
  const body: ErrorBody = { kind: "error", message };
  return `${JSON.stringify(body)}\n`;
}

async function readOptionalUtf8(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (errorCode(error) === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

async function runtimeProbes(
  env: Readonly<Record<string, string | undefined>>,
  identity: PackageIdentity,
): Promise<RuntimeReport> {
  const ffmpeg = await ffmpegCheck(env);
  const needle = await needleCheck(env, identity.cactusNeedle);
  const weights = embedWeightsPath(env);
  const ecapa: Extract<DoctorCheck, { readonly name: "ecapa" }> = (await pathExists(weights))
    ? { name: "ecapa", state: "ok", path: weights }
    : { name: "ecapa", state: "bad", path: weights };
  return [ffmpeg, needle, ecapa];
}

async function ffmpegCheck(env: Readonly<Record<string, string | undefined>>): Promise<
  Extract<DoctorCheck, { readonly name: "ffmpeg" }>
> {
  const result = await capture("ffmpeg", ["-version"], env);
  if (result.code === 0) {
    return { name: "ffmpeg", state: "ok" };
  }
  return { name: "ffmpeg", state: "bad", detail: "ffmpeg is not on PATH" };
}

async function needleCheck(
  env: Readonly<Record<string, string | undefined>>,
  expected: string,
): Promise<Extract<DoctorCheck, { readonly name: "cactus-needle" }>> {
  const result = await capture("python3", ["-c", "import needle\nprint(needle.__version__)\n"], env);
  if (result.code !== 0) {
    return { name: "cactus-needle", state: "bad", expected, found: undefined };
  }
  const found = result.stdout.trim();
  if (found === expected) {
    return { name: "cactus-needle", state: "ok", version: found };
  }
  return { name: "cactus-needle", state: "bad", expected, found };
}

function capture(
  command: string,
  args: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
): Promise<ProbeResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...args], {
      env: spawnEnv(env),
      stdio: ["ignore", "pipe", "pipe"],
    });
    const out: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => {
      out.push(chunk);
    });
    child.on("error", (error) => {
      if (errorCode(error) === "ENOENT") {
        resolve({ code: null, stdout: "" });
        return;
      }
      reject(error);
    });
    child.on("close", (code) => {
      resolve({ code, stdout: Buffer.concat(out).toString("utf8") });
    });
  });
}

function spawnEnv(env: Readonly<Record<string, string | undefined>>): NodeJS.ProcessEnv {
  const copy: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) {
      copy[key] = value;
    }
  }
  return copy;
}

async function linkRecord(path: string, format: "json" | "toml", launcher: Launcher): Promise<ServerRecord> {
  const text = await readOptionalUtf8(path);
  switch (format) {
    case "json":
      return cursorRecord(text, launcher);
    case "toml":
      return grokRecord(text, launcher);
    default: {
      const leftover: never = format;
      throw new Error(`unexpected format ${String(leftover)}`);
    }
  }
}

function cursorRecord(text: string | undefined, launcher: Launcher): ServerRecord {
  if (text === undefined || text.trim() === "") {
    return { status: "absent" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { status: "unreadable", detail: "mcp.json is not valid JSON" };
  }
  const root = asRecord(parsed);
  if (root === undefined) {
    return { status: "unreadable", detail: "mcp.json must be a JSON object" };
  }
  if (!Object.prototype.hasOwnProperty.call(root, "mcpServers")) {
    return { status: "absent" };
  }
  const servers = asRecord(root["mcpServers"]);
  if (servers === undefined) {
    return { status: "unreadable", detail: "mcpServers is not an object" };
  }
  if (!Object.prototype.hasOwnProperty.call(servers, serverName)) {
    return { status: "absent" };
  }
  const entry = servers[serverName];
  if (cursorEntryMatches(entry, launcher)) {
    return { status: "match" };
  }
  return { status: "differ", previous: previousFromCursor(entry) };
}

function cursorEntryMatches(value: unknown, launcher: Launcher): boolean {
  const record = asRecord(value);
  if (record === undefined) {
    return false;
  }
  const keys = Object.keys(record);
  if (keys.length !== 2 || !keys.includes("command") || !keys.includes("args")) {
    return false;
  }
  if (record["command"] !== launcher.command) {
    return false;
  }
  const args = stringList(record["args"]);
  if (args === undefined) {
    return false;
  }
  return sameStrings(args, launcher.args);
}

function previousFromCursor(value: unknown): PreviousEntry {
  const record = asRecord(value);
  if (record === undefined) {
    return { command: "", args: [] };
  }
  const command = typeof record["command"] === "string" ? record["command"] : "";
  return { command, args: stringList(record["args"]) ?? [] };
}

function stringList(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const args: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string") {
      return undefined;
    }
    args.push(entry);
  }
  return args;
}

function sameStrings(actual: readonly string[], expected: readonly string[]): boolean {
  if (actual.length !== expected.length) {
    return false;
  }
  for (let index = 0; index < expected.length; index += 1) {
    if (actual[index] !== expected[index]) {
      return false;
    }
  }
  return true;
}

function grokRecord(text: string | undefined, launcher: Launcher): ServerRecord {
  if (text === undefined || text.trim() === "") {
    return { status: "absent" };
  }
  const sections = scanTomlSections(text);
  if (sections === undefined) {
    return { status: "unreadable", detail: "config.toml headers cannot be scanned" };
  }
  const hits = sections.filter((section) => isPoddrillTable(section.name));
  if (hits.length > 1) {
    return { status: "unreadable", detail: "config.toml has more than one poddrill table" };
  }
  const hit = hits[0];
  if (hit === undefined) {
    return { status: "absent" };
  }
  const previous = previousFromToml(hit.body);
  if (grokBodyMatches(hit.body, launcher, previous)) {
    return { status: "match" };
  }
  return { status: "differ", previous };
}

function grokBodyMatches(body: string, launcher: Launcher, previous: PreviousEntry): boolean {
  if (!("startupTimeoutSec" in previous)) {
    return false;
  }
  const keys = assignmentKeys(body);
  if (keys === undefined) {
    return false;
  }
  if (keys.length !== 3 || !keys.includes("command") || !keys.includes("args") || !keys.includes("startup_timeout_sec")) {
    return false;
  }
  return (
    previous.command === launcher.command &&
    sameStrings(previous.args, launcher.args) &&
    previous.startupTimeoutSec === GROK_STARTUP_TIMEOUT_SEC
  );
}

function previousFromToml(body: string): PreviousEntry {
  let command = "";
  let args: readonly string[] = [];
  let startupTimeoutSec: number | null = null;
  for (const line of body.split("\n")) {
    const commandMatch = /^\s*command\s*=\s*"((?:\\.|[^"\\])*)"\s*(?:#.*)?$/.exec(line);
    if (commandMatch !== null) {
      command = unescapeToml(commandMatch[1] ?? "");
      continue;
    }
    const argsMatch = /^\s*args\s*=\s*\[(.*)\]\s*(?:#.*)?$/.exec(line);
    if (argsMatch !== null) {
      const parsed = parseTomlStringArray(argsMatch[1] ?? "");
      if (parsed !== undefined) {
        args = parsed;
      }
      continue;
    }
    const timeoutMatch = /^\s*startup_timeout_sec\s*=\s*(\d+)\s*(?:#.*)?$/.exec(line);
    if (timeoutMatch !== null && timeoutMatch[1] !== undefined) {
      startupTimeoutSec = Number(timeoutMatch[1]);
    }
  }
  return { command, args, startupTimeoutSec };
}

function assignmentKeys(body: string): readonly string[] | undefined {
  const keys: string[] = [];
  for (const line of body.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) {
      continue;
    }
    const match = /^([A-Za-z0-9_-]+)\s*=/.exec(trimmed);
    const key = match?.[1];
    if (key === undefined) {
      return undefined;
    }
    keys.push(key);
  }
  return keys;
}

function parseTomlStringArray(inner: string): readonly string[] | undefined {
  const values: string[] = [];
  let index = 0;
  while (index < inner.length) {
    const ch = inner[index];
    if (ch === undefined) {
      break;
    }
    if (ch === " " || ch === "\t" || ch === "," || ch === "\n" || ch === "\r") {
      index += 1;
      continue;
    }
    if (ch !== "\"") {
      return undefined;
    }
    index += 1;
    let value = "";
    let closed = false;
    while (index < inner.length) {
      const next = inner[index];
      if (next === undefined) {
        return undefined;
      }
      if (next === "\\") {
        const escaped = inner[index + 1];
        if (escaped === undefined) {
          return undefined;
        }
        value += escaped === "n" ? "\n" : escaped;
        index += 2;
        continue;
      }
      if (next === "\"") {
        index += 1;
        closed = true;
        values.push(value);
        break;
      }
      value += next;
      index += 1;
    }
    if (!closed) {
      return undefined;
    }
  }
  return values;
}

function unescapeToml(value: string): string {
  return value.replaceAll(/\\(.)/g, (_match, char: string) => (char === "n" ? "\n" : char));
}

function isPoddrillTable(name: string): boolean {
  const compact = name.replaceAll(" ", "").replaceAll("\t", "").replaceAll("\"", "").replaceAll("'", "");
  return compact === "mcp_servers.poddrill";
}

function scanTomlSections(text: string): readonly TomlSection[] | undefined {
  if (text.includes("\"\"\"") || text.includes("'''")) {
    return undefined;
  }
  const found: TomlSection[] = [];
  let mode: "top" | "basic" | "literal" = "top";
  let lineStart = 0;
  let index = 0;
  while (index < text.length) {
    const ch = text[index];
    if (ch === undefined) {
      break;
    }
    if (mode === "basic") {
      if (ch === "\\") {
        index += 2;
        continue;
      }
      if (ch === "\"") {
        mode = "top";
      }
      index += 1;
      continue;
    }
    if (mode === "literal") {
      if (ch === "'") {
        mode = "top";
      }
      index += 1;
      continue;
    }
    if (ch === "\n") {
      lineStart = index + 1;
      index += 1;
      continue;
    }
    if (ch === "#") {
      while (index < text.length && text[index] !== "\n") {
        index += 1;
      }
      continue;
    }
    if (ch === "\"") {
      mode = "basic";
      index += 1;
      continue;
    }
    if (ch === "'") {
      mode = "literal";
      index += 1;
      continue;
    }
    if (ch === "[" && onlySpace(text, lineStart, index)) {
      const header = readHeader(text, index);
      if (header === undefined) {
        return undefined;
      }
      const previous = found[found.length - 1];
      if (previous !== undefined) {
        found[found.length - 1] = {
          ...previous,
          bodyEnd: lineStart,
          body: text.slice(previous.bodyEnd, lineStart),
        };
      }
      found.push({
        headerStart: lineStart,
        bodyEnd: header.end,
        name: header.name,
        body: "",
      });
      index = header.end;
      continue;
    }
    index += 1;
  }
  if (mode !== "top") {
    return undefined;
  }
  const last = found[found.length - 1];
  if (last !== undefined) {
    found[found.length - 1] = { ...last, bodyEnd: text.length, body: text.slice(last.bodyEnd) };
  }
  return found;
}

function onlySpace(text: string, from: number, to: number): boolean {
  for (let index = from; index < to; index += 1) {
    const ch = text[index];
    if (ch !== " " && ch !== "\t" && ch !== "\r") {
      return false;
    }
  }
  return true;
}

function readHeader(text: string, index: number): { readonly name: string; readonly end: number } | undefined {
  const newline = text.indexOf("\n", index);
  const lineEnd = newline === -1 ? text.length : newline;
  const line = text.slice(index, lineEnd).replace(/\r$/, "");
  const match = /^\[\[?\s*([^\]]+?)\s*\]\]?\s*(?:#.*)?$/.exec(line);
  const name = match?.[1];
  if (name === undefined || name.includes("[")) {
    return undefined;
  }
  return { name, end: lineEnd };
}

async function compareAndSwap(
  path: string,
  format: "json" | "toml",
  launcher: Launcher,
): Promise<MergeResult | ClientRefusal> {
  await deleteLeftoverTemps(path);
  for (let attempt = 0; attempt < CONFIG_CAS_LIMIT; attempt += 1) {
    const current = await readOptionalUtf8(path);
    const merged = mergeText(current, format, launcher);
    if (typeof merged !== "string") {
      return {
        kind: "refused",
        reason: "unreadable-config",
        path,
        message: merged.detail,
      };
    }
    if (current !== undefined && current === merged) {
      return "unchanged";
    }
    const temp = `${path}.${serverName}-${randomBytes(6).toString("hex")}.tmp`;
    await mkdir(dirname(path), { recursive: true });
    await writeFile(temp, merged);
    const again = await readOptionalUtf8(path);
    if (again === current) {
      await rename(temp, path);
      return "written";
    }
    await rm(temp, { force: true });
  }
  return {
    kind: "refused",
    reason: "config-race",
    message: `${path} changed while it was being written`,
  };
}

function mergeText(
  current: string | undefined,
  format: "json" | "toml",
  launcher: Launcher,
): string | { readonly detail: string } {
  switch (format) {
    case "json":
      return mergeCursor(current, launcher);
    case "toml":
      return mergeGrok(current, launcher);
    default: {
      const leftover: never = format;
      throw new Error(`unexpected format ${String(leftover)}`);
    }
  }
}

function mergeCursor(current: string | undefined, launcher: Launcher): string | { readonly detail: string } {
  const entry = { command: launcher.command, args: [...launcher.args] };
  if (current === undefined || current.trim() === "") {
    return `${JSON.stringify({ mcpServers: { [serverName]: entry } }, null, 2)}\n`;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(current);
  } catch {
    return { detail: "mcp.json is not valid JSON" };
  }
  const root = asRecord(parsed);
  if (root === undefined) {
    return { detail: "mcp.json must be a JSON object" };
  }
  const serversValue = root["mcpServers"];
  if (serversValue !== undefined && asRecord(serversValue) === undefined) {
    return { detail: "mcpServers is not an object" };
  }
  const servers = asRecord(serversValue) ?? {};
  const next = { ...root, mcpServers: { ...servers, [serverName]: entry } };
  return `${JSON.stringify(next, null, 2)}\n`;
}

function mergeGrok(current: string | undefined, launcher: Launcher): string | { readonly detail: string } {
  const table = desiredGrokTable(launcher);
  if (current === undefined || current.trim() === "") {
    return table;
  }
  const sections = scanTomlSections(current);
  if (sections === undefined) {
    return { detail: "config.toml headers cannot be scanned" };
  }
  const hits = sections.filter((section) => isPoddrillTable(section.name));
  if (hits.length > 1) {
    return { detail: "config.toml has more than one poddrill table" };
  }
  const hit = hits[0];
  if (hit === undefined) {
    const prefix = current.endsWith("\n") ? current : `${current}\n`;
    return `${prefix}\n${table}`;
  }
  return `${current.slice(0, hit.headerStart)}${table}${current.slice(hit.bodyEnd)}`;
}

function desiredGrokTable(launcher: Launcher): string {
  const args = launcher.args.map((arg) => `"${escapeToml(arg)}"`).join(", ");
  return [
    "[mcp_servers.poddrill]",
    `command = "${escapeToml(launcher.command)}"`,
    `args = [${args}]`,
    `startup_timeout_sec = ${GROK_STARTUP_TIMEOUT_SEC}`,
    "",
  ].join("\n");
}

function escapeToml(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("\"", "\\\"");
}

async function deleteLeftoverTemps(path: string): Promise<void> {
  const dir = dirname(path);
  const prefix = `${basename(path)}.${serverName}-`;
  let names: readonly string[];
  try {
    names = await readdir(dir);
  } catch (error) {
    if (errorCode(error) === "ENOENT") {
      return;
    }
    throw error;
  }
  for (const name of names) {
    if (name.startsWith(prefix) && name.endsWith(".tmp")) {
      await rm(join(dir, name), { force: true });
    }
  }
}

async function staysInHome(home: string, candidate: string): Promise<boolean> {
  if (!pathStaysInHome(home, candidate)) {
    return false;
  }
  let homeReal: string;
  try {
    homeReal = await realpath(home);
  } catch (error) {
    if (errorCode(error) !== "ENOENT") {
      throw error;
    }
    await mkdir(home, { recursive: true });
    homeReal = await realpath(home);
  }
  return pathStaysInHome(homeReal, await resolveFromExisting(candidate));
}

async function resolveFromExisting(candidate: string): Promise<string> {
  const pending: string[] = [];
  let current = candidate;
  for (;;) {
    try {
      const found = await realpath(current);
      const rest = [...pending].reverse();
      return rest.length === 0 ? found : join(found, ...rest);
    } catch (error) {
      if (errorCode(error) !== "ENOENT") {
        throw error;
      }
      const parent = dirname(current);
      if (parent === current) {
        return normalize(candidate);
      }
      pending.push(basename(current));
      current = parent;
    }
  }
}

async function observeSkill(dest: string, bundle: string): Promise<SkillView> {
  const parent = dirname(dest);
  const liveName = basename(dest);
  let names: readonly string[];
  try {
    names = await readdir(parent);
  } catch (error) {
    if (errorCode(error) === "ENOENT") {
      return { live: "absent", partialNext: [], completeNext: [], prev: [], orphanMarkers: [] };
    }
    throw error;
  }
  const bundleFiles = await filesIn(bundle);
  const partialNext: string[] = [];
  const completeNext: string[] = [];
  const prev: string[] = [];
  const orphanMarkers: string[] = [];
  const nameSet = new Set(names);
  for (const name of names) {
    const full = join(parent, name);
    if (name === liveName) {
      continue;
    }
    if (isMarkerName(name)) {
      const stem = name.slice(0, -skillMarkerSuffix.length);
      if (!nameSet.has(stem) || !(await isDirectory(join(parent, stem)))) {
        orphanMarkers.push(full);
      }
      continue;
    }
    if (name.startsWith(skillNextPrefix)) {
      const marked = await pathExists(markerPath(full));
      const directory = await isDirectory(full);
      const files = directory ? await filesIn(full) : undefined;
      if (directory && marked && bundleFiles !== undefined && files !== undefined && sameFiles(files, bundleFiles)) {
        completeNext.push(full);
      } else {
        partialNext.push(full);
      }
      continue;
    }
    if (name.startsWith(skillPrevPrefix)) {
      prev.push(full);
    }
  }
  let live: SkillView["live"] = "absent";
  if (nameSet.has(liveName)) {
    const files = (await isDirectory(dest)) ? await filesIn(dest) : undefined;
    live =
      files !== undefined && bundleFiles !== undefined && sameFiles(files, bundleFiles) ? "match" : "differ";
  }
  partialNext.sort();
  completeNext.sort();
  prev.sort();
  orphanMarkers.sort();
  return { live, partialNext, completeNext, prev, orphanMarkers };
}

function isMarkerName(name: string): boolean {
  return name.startsWith(skillNextPrefix) && name.endsWith(skillMarkerSuffix);
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    const info = await statSafe(path);
    return info?.isDirectory() ?? false;
  } catch (error) {
    if (errorCode(error) === "ENOENT") {
      return false;
    }
    throw error;
  }
}

async function statSafe(path: string): Promise<{ isDirectory(): boolean } | undefined> {
  try {
    return await stat(path);
  } catch (error) {
    if (errorCode(error) === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

async function filesIn(dir: string): Promise<Map<string, Buffer> | undefined> {
  const info = await statSafe(dir);
  if (info === undefined) {
    return undefined;
  }
  if (!info.isDirectory()) {
    return new Map([["", await readFile(dir)]]);
  }
  const out = new Map<string, Buffer>();
  await walkFiles(dir, dir, out);
  return out;
}

async function walkFiles(root: string, dir: string, out: Map<string, Buffer>): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      await walkFiles(root, path, out);
      continue;
    }
    if (entry.isFile()) {
      out.set(relative(root, path), await readFile(path));
    }
  }
}

function sameFiles(left: Map<string, Buffer>, right: Map<string, Buffer>): boolean {
  if (left.size !== right.size) {
    return false;
  }
  for (const [key, bytes] of left) {
    const other = right.get(key);
    if (other === undefined || !other.equals(bytes)) {
      return false;
    }
  }
  return true;
}

async function runSkillStep(dest: string, bundle: string, step: SkillStep): Promise<void> {
  switch (step.op) {
    case "done":
      return;
    case "drop":
      await rm(step.path, { recursive: true, force: true });
      if (!step.path.endsWith(skillMarkerSuffix)) {
        await rm(markerPath(step.path), { force: true });
      }
      return;
    case "stage": {
      const next = join(dirname(dest), `${skillNextPrefix}${randomBytes(8).toString("hex")}`);
      await cp(bundle, next, { recursive: true });
      await writeFile(markerPath(next), "");
      return;
    }
    case "promote":
      try {
        await rename(step.path, dest);
      } catch (error) {
        const code = errorCode(error);
        if (code === "EEXIST" || code === "ENOTEMPTY" || code === "ENOENT") {
          return;
        }
        throw error;
      }
      return;
    case "aside": {
      const prev = join(dirname(dest), `${skillPrevPrefix}${randomBytes(8).toString("hex")}`);
      try {
        await rename(dest, prev);
      } catch (error) {
        if (errorCode(error) === "ENOENT") {
          return;
        }
        throw error;
      }
      return;
    }
    default: {
      const leftover: never = step;
      throw new Error(`unexpected skill step ${JSON.stringify(leftover)}`);
    }
  }
}
