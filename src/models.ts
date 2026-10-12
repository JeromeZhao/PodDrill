/**
 * One row per language. `fleetLimit` is the size for every model, and `modelFleet` overrides one id.
 */

export const modelIds = [
  "whistle",
  "moonshine-tiny-ja",
  "moonshine-tiny-ko",
  "moonshine-base-zh",
] as const;

export type ModelId = (typeof modelIds)[number];

export type ModelFleet = Readonly<Partial<Record<ModelId, number>>>;

export type ModelWeights = Readonly<Partial<Record<ModelId, string>>>;

const languageModels = [
  { id: "whistle", engine: "whistle", language: "en" },
  { id: "whistle", engine: "whistle", language: "de" },
  { id: "whistle", engine: "whistle", language: "fr" },
  { id: "whistle", engine: "whistle", language: "es" },
  { id: "whistle", engine: "whistle", language: "it" },
  { id: "whistle", engine: "whistle", language: "nl" },
  { id: "whistle", engine: "whistle", language: "pl" },
  { id: "moonshine-tiny-ja", engine: "moonshine", language: "ja", arch: "tiny" },
  { id: "moonshine-tiny-ko", engine: "moonshine", language: "ko", arch: "tiny" },
  { id: "moonshine-base-zh", engine: "moonshine", language: "zh", arch: "base" },
] as const;

export type LanguageModel = (typeof languageModels)[number];

export function isModelId(value: string): value is ModelId {
  for (const id of modelIds) {
    if (id === value) {
      return true;
    }
  }
  return false;
}

/** `undefined` for a language that has no row. */
export function modelForLanguage(language: string): LanguageModel | undefined {
  for (const row of languageModels) {
    if (row.language === language) {
      return row;
    }
  }
  return undefined;
}

export function fleetSize(
  modelId: ModelId,
  config: { readonly fleetLimit: number; readonly modelFleet: ModelFleet },
): number {
  const sized = config.modelFleet[modelId];
  if (sized === undefined) {
    return config.fleetLimit;
  }
  return sized;
}
