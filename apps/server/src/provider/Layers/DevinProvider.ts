import {
  type DevinSettings,
  type ModelCapabilities,
  type ModelPricing,
  type ProviderOptionChoice,
  type ProviderOptionDescriptor,
  type ProviderOptionVariant,
  type SelectProviderOptionDescriptor,
  type ServerProviderModel,
} from "@t3tools/contracts";
import { createModelCapabilities } from "@t3tools/shared/model";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { ChildProcess } from "effect/unstable/process";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import {
  buildServerProvider,
  isCommandMissingCause,
  parseGenericCliVersion,
  providerModelsFromSettings,
  spawnAndCollect,
  type ServerProviderDraft,
} from "../providerSnapshot.ts";

/**
 * Bumped whenever Devin's model inventory representation changes. The
 * provider registry uses this marker to prevent an older flattened snapshot
 * from being merged into the parent/family catalog. v3 invalidates snapshots
 * written by the first grouped implementation so the picker cannot retain
 * rows such as `Max 1M`, `Fast`, or `Priority` as standalone models.
 */
export const DEVIN_MODEL_CATALOG_VERSION = "devin-model-catalog-v4";

const DEVIN_PRESENTATION = {
  displayName: "Devin",
  badgeLabel: "Early Access",
  showInteractionModeToggle: true,
  requiresNewThreadForModelChange: false,
  modelCatalogVersion: DEVIN_MODEL_CATALOG_VERSION,
} as const;

const EMPTY_CAPABILITIES: ModelCapabilities = createModelCapabilities({ optionDescriptors: [] });
const VERSION_PROBE_TIMEOUT_MS = 4_000;
const MODEL_PROBE_TIMEOUT_MS = 15_000;

/**
 * Reasoning levels Devin bakes into model UIDs as a trailing suffix, ordered
 * from least to most effort. Used both to group variants into a single
 * selectable model and to order the option choices in the picker.
 */
const DEVIN_REASONING_LEVELS = [
  "none",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "thinking",
] as const;

const DEVIN_REASONING_LABELS: Readonly<Record<string, string>> = {
  none: "None",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "X-High",
  max: "Max",
  thinking: "Thinking",
};
const DEVIN_SPEED_LABELS: Readonly<Record<string, string>> = {
  standard: "Standard",
  fast: "Fast",
  priority: "Priority",
};
const DEVIN_DEFAULT_CONTEXT_WINDOWS: Readonly<Record<string, string>> = {
  "glm-5-2": "200k",
};

/**
 * Fallback context sizes used when an ACP/CLI catalog omits the field. Devin
 * currently advertises these limits in its model catalog. Keeping this map in
 * the provider layer means the context meter still has a useful denominator
 * while a model is streaming its first usage update.
 */
const DEVIN_CONTEXT_WINDOWS: Readonly<Record<string, number>> = {
  "claude-opus-5": 1_000_000,
  "claude-5-fable": 1_000_000,
  "claude-sonnet-5": 1_000_000,
  "gemini-3-7-flash": 1_048_576,
  "gpt-5-6-sol": 1_000_000,
  "gpt-5-6-luna": 1_000_000,
  "glm-5-2": 200_000,
  "kimi-k3": 1_048_576,
  "swe-1-7": 262_000,
  "swe-1-7-lightning": 202_752,
  adaptive: 1_000_000,
  "claude-opus-4-7": 1_000_000,
  "claude-opus-4-8": 1_000_000,
  "gemini-3-5-flash": 1_048_576,
  "gemini-3-6-flash": 1_048_576,
  "gpt-5-6-terra": 1_000_000,
  "grok-4-5": 500_000,
  "grok-4-6": 500_000,
  inkling: 1_048_576,
  "deepseek-v4-flash": 1_048_576,
  "claude-opus-4-6": 200_000,
  "gpt-5-4": 272_000,
  "gpt-5-5": 272_000,
  "gpt-5-4-mini": 400_000,
  "claude-sonnet-4-6": 200_000,
  "gpt-5-2": 384_000,
  model_gpt_5_2: 384_000,
  "claude-opus-4-5": 200_000,
  "claude-haiku-4-5": 200_000,
  "claude-sonnet-4-5": 200_000,
  "gpt-4-1": 1_047_576,
  "gpt-5-1": 272_000,
  model_private_12: 272_000,
  model_private_13: 272_000,
  model_private_14: 272_000,
  model_private_15: 272_000,
  "gpt-5-3-codex": 400_000,
  "kimi-k2-6": 262_144,
  "kimi-k2-7": 262_144,
  "nemotron-3-ultra": 1_000_000,
  "swe-1-6": 200_000,
  "swe-1-6-fast": 200_000,
  "gemini-3-1-pro": 1_048_576,
  "gemini-3-flash": 1_048_576,
  "deepseek-v4-pro": 1_048_576,
};

export function inferDevinContextWindowTokens(
  modelUid: string | null | undefined,
): number | undefined {
  const trimmed = modelUid?.trim();
  if (!trimmed) return undefined;
  const parsed = parseDevinModelUid(trimmed);
  if (parsed.contextWindow) return parseContext(parsed.contextWindow) * 1_000;
  const normalizedBase = parsed.base.toLowerCase();
  return (
    DEVIN_CONTEXT_WINDOWS[normalizedBase] ??
    DEVIN_CONTEXT_WINDOWS[normalizedBase.replaceAll("_", "-")]
  );
}

/**
 * Speed suffixes that follow the reasoning level in a model UID
 * (e.g. `claude-opus-5-medium-fast`). Kept separate from reasoning so the
 * group key can carry the speed while reasoning becomes an option choice.
 */
const LOWER_REASONING_SUFFIX = /-(none|low|medium|high|xhigh|max|thinking)$/;
const LOWER_SPEED_SUFFIX = /-(fast|priority)$/;
const UPPER_REASONING_SUFFIX = /_(NONE|LOW|MEDIUM|HIGH|XHIGH|MAX|THINKING)$/;
const UPPER_SPEED_SUFFIX = /_(FAST|PRIORITY)$/;
const LOWER_CONTEXT_SUFFIX = /-(\d+(?:k|m))$/i;
const UPPER_CONTEXT_SUFFIX = /_(\d+(?:K|M))$/;

function capitalize(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1);
}

function parseContext(value: string): number {
  const match = value.match(/^(\d+)(k|m)$/i);
  if (!match) return Number.MAX_SAFE_INTEGER;
  const amount = Number(match[1]);
  return match[2]!.toLowerCase() === "m" ? amount * 1000 : amount;
}

function inferReasoningFromLabel(label: string): string {
  const normalized = label.toLowerCase();
  if (normalized.includes("no thinking") || normalized.includes("none")) return "none";
  for (const level of ["xhigh", "high", "medium", "low", "max", "thinking"]) {
    if (normalized.includes(level)) return level;
  }
  return "none";
}

function labelHasReasoningSignal(label: string): boolean {
  return /\b(?:no\s+thinking|none|low|medium|high|x[- ]?high|max|thinking)\b/iu.test(label);
}

/**
 * Extracts the `{ base, reasoning, speed }` triple from a Devin model UID.
 *
 * Devin bakes the reasoning level (and an optional speed tier) into the UID
 * as a trailing suffix: `claude-opus-5-medium`, `claude-opus-5-medium-fast`.
 * Uppercase enum-style UIDs use underscore separators: `MODEL_GPT_5_2_LOW`.
 *
 * Speed only counts when a reasoning level precedes it — a bare `-fast`
 * without a reasoning suffix is treated as part of the base so it cannot
 * collide with a grouped family that happens to share the same speed tier.
 * Models with no recognizable reasoning suffix are single variants.
 */
export function parseDevinModelUid(uid: string): {
  base: string;
  reasoning: string | undefined;
  speed: string | undefined;
  contextWindow: string | undefined;
} {
  const trimmed = uid.trim();
  const strip = (value: string, re: RegExp): [string, string] | undefined => {
    const match = value.match(re);
    if (!match) return undefined;
    return [value.slice(0, value.length - match[0].length), match[1]!.toLowerCase()];
  };

  const contextMatch = strip(trimmed, LOWER_CONTEXT_SUFFIX) ?? strip(trimmed, UPPER_CONTEXT_SUFFIX);
  const withoutContext = contextMatch?.[0] ?? trimmed;
  const contextWindow = contextMatch?.[1];
  const speedMatch =
    strip(withoutContext, LOWER_SPEED_SUFFIX) ?? strip(withoutContext, UPPER_SPEED_SUFFIX);
  if (speedMatch) {
    const [afterSpeed, speed] = speedMatch;
    const reasoningMatch =
      strip(afterSpeed, LOWER_REASONING_SUFFIX) ?? strip(afterSpeed, UPPER_REASONING_SUFFIX);
    if (reasoningMatch) {
      return { base: reasoningMatch[0], reasoning: reasoningMatch[1], speed, contextWindow };
    }
  }

  const reasoningMatch =
    strip(withoutContext, LOWER_REASONING_SUFFIX) ?? strip(withoutContext, UPPER_REASONING_SUFFIX);
  if (reasoningMatch) {
    return {
      base: reasoningMatch[0],
      reasoning: reasoningMatch[1],
      speed: undefined,
      contextWindow,
    };
  }
  return { base: withoutContext, reasoning: undefined, speed: undefined, contextWindow };
}

/**
 * Group key for a parsed UID: the family base, with reasoning, speed, and
 * context-window qualifiers removed. All variants in a Devin family collapse
 * into one selectable parent model under this key; the qualifiers become
 * option descriptors on that row.
 */
export function devinModelGroupKey(parsed: { base: string; speed?: string | undefined }): string {
  return parsed.base;
}

/**
 * Known per-model input capabilities for Devin models.
 *
 * The `devin models list --format json` payload (see `DevinModelsPayload`)
 * reports model families and variants but does not advertise input
 * modalities, so we map them here from the model_uid. Devin is an agentic
 * coding harness: every catalogued model accepts text, pasted/attached
 * images, and uploaded file context. None of the current models accept
 * audio input, so `inputAudio` is false across the board. A model_uid that
 * is absent from this map falls back to the default (all modalities
 * supported), which keeps newly added Devin models usable until this map
 * is refreshed.
 */
const DEVIN_MODEL_INPUT_CAPABILITIES: Readonly<
  Record<string, { inputImages?: boolean; inputAudio?: boolean; inputFiles?: boolean }>
> = {
  adaptive: { inputAudio: false },
};

function devinModelCapabilities(slug: string): ModelCapabilities {
  const overrides = DEVIN_MODEL_INPUT_CAPABILITIES[slug];
  if (!overrides) {
    return EMPTY_CAPABILITIES;
  }
  return createModelCapabilities({
    optionDescriptors: [],
    ...overrides,
  });
}

const DEVIN_PRICING_SOURCE = "devin-cli models list";

function finiteNonNegative(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function firstFiniteNonNegative(record: Record<string, unknown>, keys: ReadonlyArray<string>) {
  for (const key of keys) {
    const value = finiteNonNegative(record[key]);
    if (value !== undefined) return value;
  }
  return undefined;
}

/** Read either a per-million or per-token rate and normalize it to USD per
 * million tokens. Devin has used both spellings across CLI releases, and a
 * nested `pricing` object is used by newer releases. */
function readNormalizedRate(
  record: Record<string, unknown>,
  perMillionKeys: ReadonlyArray<string>,
  perTokenKeys: ReadonlyArray<string>,
): number | undefined {
  const perMillion = firstFiniteNonNegative(record, perMillionKeys);
  if (perMillion !== undefined) return perMillion;
  const perToken = firstFiniteNonNegative(record, perTokenKeys);
  return perToken === undefined ? undefined : perToken * 1_000_000;
}

function perMillionToPricing(input: {
  readonly input: number;
  readonly cachedInput?: number;
  readonly cacheCreation?: number;
  readonly output: number;
  readonly contextWindowTokens?: number;
}): ModelPricing {
  return {
    inputPerMillion: input.input,
    ...(input.cachedInput !== undefined ? { cachedInputPerMillion: input.cachedInput } : {}),
    ...(input.cacheCreation !== undefined ? { cacheCreationPerMillion: input.cacheCreation } : {}),
    outputPerMillion: input.output,
    ...(input.contextWindowTokens !== undefined
      ? { contextWindowTokens: input.contextWindowTokens }
      : {}),
    currency: "USD",
    source: DEVIN_PRICING_SOURCE,
  };
}

function parseContextWindowTokens(value: unknown): number | undefined {
  if (typeof value === "number") return finiteNonNegative(value);
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  const match = /^(\d+(?:\.\d+)?)\s*(k|m)?$/.exec(normalized);
  if (!match) return undefined;
  const amount = Number(match[1]);
  if (!Number.isFinite(amount) || amount <= 0) return undefined;
  const multiplier = match[2] === "m" ? 1_000_000 : match[2] === "k" ? 1_000 : 1;
  return Math.round(amount * multiplier);
}

function formatContextWindowOption(tokens: number): string | undefined {
  if (!Number.isFinite(tokens) || tokens <= 0) return undefined;
  if (tokens % 1_000_000 === 0) return `${tokens / 1_000_000}m`;
  if (tokens % 1_000 === 0) return `${tokens / 1_000}k`;
  return `${tokens}`;
}

const DEVIN_COST_RATE_PATTERN =
  /\$\s*(\d+(?:\.\d+)?)\s*\/\s*1M\s*(Input|Cached\s+input|Cache\s*(?:write|creation)|Output)\b/giu;

/**
 * Parse Devin's `cost_summary` string ("$4 / 1M Input · $0.2 / 1M Cached
 * input · $20 / 1M Output · Sidekick: Free") back into per-million rates.
 * Non-rate segments such as the Fusion sidekick marker are ignored.
 */
export function parseDevinCostSummary(summary: string): {
  input?: number;
  cachedInput?: number;
  cacheCreation?: number;
  output?: number;
} {
  const rates: { input?: number; cachedInput?: number; cacheCreation?: number; output?: number } =
    {};
  for (const match of summary.matchAll(DEVIN_COST_RATE_PATTERN)) {
    const amount = Number(match[1]);
    if (!Number.isFinite(amount)) continue;
    const kind = match[2]!.toLowerCase().replaceAll(/\s+/gu, " ");
    if (kind === "input") rates.input = amount;
    else if (kind === "cached input") rates.cachedInput = amount;
    else if (kind === "output") rates.output = amount;
    else rates.cacheCreation ??= amount;
  }
  return rates;
}

function variantContextWindowTokens(variant: Record<string, unknown>): number | undefined {
  return (
    parseContextWindowTokens(variant.max_context_tokens ?? variant.maxContextTokens) ??
    parseContextWindowTokens(variant.context_window ?? variant.contextWindow)
  );
}

function variantMaxOutputTokens(variant: Record<string, unknown>): number | undefined {
  return parseContextWindowTokens(variant.max_output_tokens ?? variant.maxOutputTokens);
}

function variantCostTier(variant: Record<string, unknown>): string | undefined {
  const raw = variant.cost_tier ?? variant.costTier;
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim().replace(/\s*cost$/iu, "");
  return trimmed || undefined;
}

function variantBadge(variant: Record<string, unknown>): "new" | "beta" | undefined {
  if (variant.is_new === true || variant.isNew === true) return "new";
  if (variant.is_beta === true || variant.isBeta === true) return "beta";
  return undefined;
}

/**
 * Accepts the JSON shapes used by different Devin CLI releases. Older builds
 * expose flat `*_per_million` fields, while newer builds nest rates under a
 * `pricing` object and use per-token values. Current builds report a
 * `cost_summary` string instead, which is parsed back into rates. The
 * normalized result is always USD per million tokens so it can be persisted
 * in the provider snapshot.
 */
function parseDevinVariantPricing(variant: Record<string, unknown>): ModelPricing | undefined {
  const nested =
    variant.pricing && typeof variant.pricing === "object" && !Array.isArray(variant.pricing)
      ? (variant.pricing as Record<string, unknown>)
      : {};
  const summaryRates = (() => {
    const summary = variant.cost_summary ?? variant.costSummary;
    return typeof summary === "string" ? parseDevinCostSummary(summary) : {};
  })();
  const input =
    readNormalizedRate(
      variant,
      ["input_per_million", "inputPerMillion", "input_cost_per_million", "inputCostPerMillion"],
      ["input_cost_per_token", "inputCostPerToken"],
    ) ??
    readNormalizedRate(
      nested,
      ["input_per_million", "inputPerMillion", "input_cost_per_million", "inputCostPerMillion"],
      ["input_cost_per_token", "inputCostPerToken"],
    ) ??
    summaryRates.input;
  const output =
    readNormalizedRate(
      variant,
      ["output_per_million", "outputPerMillion", "output_cost_per_million", "outputCostPerMillion"],
      ["output_cost_per_token", "outputCostPerToken"],
    ) ??
    readNormalizedRate(
      nested,
      ["output_per_million", "outputPerMillion", "output_cost_per_million", "outputCostPerMillion"],
      ["output_cost_per_token", "outputCostPerToken"],
    ) ??
    summaryRates.output;
  if (input === undefined || output === undefined) return undefined;

  const cached =
    readNormalizedRate(
      variant,
      [
        "cached_input_per_million",
        "cachedInputPerMillion",
        "cache_read_cost_per_million",
        "cacheReadCostPerMillion",
      ],
      [
        "cached_input_cost_per_token",
        "cachedInputCostPerToken",
        "cache_read_cost_per_token",
        "cacheReadCostPerToken",
      ],
    ) ??
    readNormalizedRate(
      nested,
      [
        "cached_input_per_million",
        "cachedInputPerMillion",
        "cache_read_cost_per_million",
        "cacheReadCostPerMillion",
      ],
      [
        "cached_input_cost_per_token",
        "cachedInputCostPerToken",
        "cache_read_cost_per_token",
        "cacheReadCostPerToken",
      ],
    ) ??
    summaryRates.cachedInput;
  const cacheCreation =
    readNormalizedRate(
      variant,
      [
        "cache_creation_per_million",
        "cacheCreationPerMillion",
        "cache_write_cost_per_million",
        "cacheWriteCostPerMillion",
      ],
      [
        "cache_creation_cost_per_token",
        "cacheCreationCostPerToken",
        "cache_write_cost_per_token",
        "cacheWriteCostPerToken",
      ],
    ) ??
    readNormalizedRate(
      nested,
      [
        "cache_creation_per_million",
        "cacheCreationPerMillion",
        "cache_write_cost_per_million",
        "cacheWriteCostPerMillion",
      ],
      [
        "cache_creation_cost_per_token",
        "cacheCreationCostPerToken",
        "cache_write_cost_per_token",
        "cacheWriteCostPerToken",
      ],
    ) ??
    summaryRates.cacheCreation;
  const contextWindowTokens =
    variantContextWindowTokens(variant) ??
    parseContextWindowTokens(nested.context_window ?? nested.contextWindow);
  return perMillionToPricing({
    input,
    ...(cached !== undefined ? { cachedInput: cached } : {}),
    ...(cacheCreation !== undefined ? { cacheCreation } : {}),
    output,
    ...(contextWindowTokens !== undefined ? { contextWindowTokens } : {}),
  });
}

function pricingWithContext(
  pricing: ModelPricing | undefined,
  contextWindowTokens: number | undefined,
): ModelPricing | undefined {
  if (!pricing) return undefined;
  if (pricing.contextWindowTokens !== undefined || contextWindowTokens === undefined) {
    return pricing;
  }
  return { ...pricing, contextWindowTokens };
}

function modelPricingRecord(
  variants: ReadonlyMap<string, ModelPricing>,
): Readonly<Record<string, ModelPricing>> | undefined {
  if (variants.size === 0) return undefined;
  return Object.fromEntries(variants.entries());
}

const DevinModelVariant = Schema.Struct({
  model_uid: Schema.String,
  label: Schema.String,
  description: Schema.optional(Schema.String),
  context_window: Schema.optional(Schema.Union([Schema.Number, Schema.String])),
  contextWindow: Schema.optional(Schema.Union([Schema.Number, Schema.String])),
  max_context_tokens: Schema.optional(Schema.Union([Schema.Number, Schema.String])),
  maxContextTokens: Schema.optional(Schema.Union([Schema.Number, Schema.String])),
  max_output_tokens: Schema.optional(Schema.Union([Schema.Number, Schema.String])),
  maxOutputTokens: Schema.optional(Schema.Union([Schema.Number, Schema.String])),
  cost_summary: Schema.optional(Schema.String),
  costSummary: Schema.optional(Schema.String),
  cost_tier: Schema.optional(Schema.String),
  costTier: Schema.optional(Schema.String),
  is_new: Schema.optional(Schema.Boolean),
  isNew: Schema.optional(Schema.Boolean),
  is_beta: Schema.optional(Schema.Boolean),
  isBeta: Schema.optional(Schema.Boolean),
  input_per_million: Schema.optional(Schema.Number),
  output_per_million: Schema.optional(Schema.Number),
  cached_input_per_million: Schema.optional(Schema.Number),
  cache_creation_per_million: Schema.optional(Schema.Number),
  input_cost_per_million: Schema.optional(Schema.Number),
  output_cost_per_million: Schema.optional(Schema.Number),
  cache_read_cost_per_million: Schema.optional(Schema.Number),
  cache_write_cost_per_million: Schema.optional(Schema.Number),
  input_cost_per_token: Schema.optional(Schema.Number),
  output_cost_per_token: Schema.optional(Schema.Number),
  cached_input_cost_per_token: Schema.optional(Schema.Number),
  cache_creation_cost_per_token: Schema.optional(Schema.Number),
  cache_read_cost_per_token: Schema.optional(Schema.Number),
  cache_write_cost_per_token: Schema.optional(Schema.Number),
  inputPerMillion: Schema.optional(Schema.Number),
  outputPerMillion: Schema.optional(Schema.Number),
  cachedInputPerMillion: Schema.optional(Schema.Number),
  cacheCreationPerMillion: Schema.optional(Schema.Number),
  inputCostPerToken: Schema.optional(Schema.Number),
  outputCostPerToken: Schema.optional(Schema.Number),
  cachedInputCostPerToken: Schema.optional(Schema.Number),
  cacheCreationCostPerToken: Schema.optional(Schema.Number),
  cacheReadCostPerToken: Schema.optional(Schema.Number),
  cacheWriteCostPerToken: Schema.optional(Schema.Number),
  cacheReadCostPerMillion: Schema.optional(Schema.Number),
  cacheWriteCostPerMillion: Schema.optional(Schema.Number),
  pricing: Schema.optional(Schema.Unknown),
});

const DevinModelFamily = Schema.Struct({
  family_label: Schema.String,
  family_uid: Schema.String,
  slug: Schema.optional(Schema.String),
  aliases: Schema.optional(Schema.Array(Schema.String)),
  variants: Schema.Array(DevinModelVariant),
});

const DevinModelsPayload = Schema.Struct({
  families: Schema.Array(DevinModelFamily),
});

const decodeDevinModels = Schema.decodeUnknownEffect(Schema.fromJsonString(DevinModelsPayload));

/** Parse the human-readable fallback emitted by older Devin CLIs. */
export function parseDevinHumanModelList(output: string): typeof DevinModelsPayload.Type | null {
  const families: Array<{
    family_label: string;
    family_uid: string;
    variants: Array<Record<string, unknown>>;
  }> = [];
  let current:
    | {
        family_label: string;
        family_uid: string;
        variants: Array<Record<string, unknown>>;
      }
    | undefined;

  for (const line of output.split(/\r?\n/u)) {
    const familyMatch = /^\s*([^()\r\n]+?)\s+\(([^()\r\n]+)\)\s*$/u.exec(line);
    if (familyMatch) {
      if (familyMatch[1]!.trim().toLowerCase() === "available models") continue;
      current = {
        family_label: familyMatch[1]!.trim(),
        family_uid: familyMatch[2]!.trim(),
        variants: [],
      };
      families.push(current);
      continue;
    }
    if (!current || /^\s*aliases?:/iu.test(line)) continue;

    const variantMatch = /^\s{2,}(\S+)\s+(.+?)(?:\s+\[(.*)\])?\s*$/u.exec(line);
    if (!variantMatch) continue;
    const modelUid = variantMatch[1]!.trim();
    const label = variantMatch[2]!.trim();
    if (!modelUid || !label || modelUid === "Available") continue;

    const details = variantMatch[3] ?? "";
    const contextMatch = /(\d+(?:\.\d+)?)\s*(k|m)?\s+context\b/iu.exec(details);
    const contextWindowTokens = contextMatch
      ? parseContextWindowTokens(`${contextMatch[1]}${contextMatch[2] ?? ""}`)
      : undefined;
    const rates = parseDevinCostSummary(details);
    const isFree = /\bfree\b/iu.test(details);
    current.variants.push({
      model_uid: modelUid,
      label,
      ...(contextWindowTokens !== undefined ? { contextWindow: contextWindowTokens } : {}),
      ...(rates.input !== undefined || isFree
        ? {
            pricing: {
              inputPerMillion: rates.input ?? 0,
              cachedInputPerMillion: rates.cachedInput,
              outputPerMillion: rates.output ?? 0,
            },
          }
        : {}),
    });
  }

  return families.length > 0 ? ({ families } as unknown as typeof DevinModelsPayload.Type) : null;
}

export function buildInitialDevinProviderSnapshot(
  settings: DevinSettings,
): Effect.Effect<ServerProviderDraft> {
  return Effect.gen(function* () {
    const checkedAt = DateTime.formatIso(yield* DateTime.now);
    const models = providerModelsFromSettings([], settings.customModels, EMPTY_CAPABILITIES);
    return buildServerProvider({
      presentation: DEVIN_PRESENTATION,
      enabled: settings.enabled,
      checkedAt,
      models,
      probe: settings.enabled
        ? {
            installed: true,
            version: null,
            status: "warning",
            auth: { status: "unknown" },
            message: "Checking Devin CLI availability...",
          }
        : {
            installed: false,
            version: null,
            status: "warning",
            auth: { status: "unknown" },
            message: "Devin is disabled in T3 Code settings.",
          },
    });
  });
}

function runDevinCommand(
  settings: Pick<DevinSettings, "binaryPath">,
  args: ReadonlyArray<string>,
  environment?: NodeJS.ProcessEnv,
) {
  return Effect.gen(function* () {
    const command = settings.binaryPath || "devin";
    const spawn = yield* resolveSpawnCommand(
      command,
      args,
      environment ? { env: environment } : {},
    );
    return yield* spawnAndCollect(
      command,
      ChildProcess.make(spawn.command, spawn.args, {
        ...(environment ? { env: environment } : { extendEnv: true }),
        shell: spawn.shell,
      }),
    );
  });
}

/** Family labels for resolving Fusion lead/sidekick ids to display names. */
type DevinFamilyLabels = ReadonlyMap<string, string>;

/**
 * The Fusion family composes a lead model + effort + optional fast tier with
 * a sidekick model into one concrete UID per valid pairing. It collapses to a
 * single `fusion` model row whose dependent controls are described by an
 * `optionVariants` table — see docs/superpowers/specs/2026-09-12-devin-fusion-design.md.
 */
const FUSION_FAMILY_UID = "fusion";

const FUSION_EFFORT_SUFFIX = /-(none|low|medium|high|xhigh|max|thinking)$/;
const FUSION_SPEED_SUFFIX = /-(fast|priority)$/;

/**
 * Split `fusion-<lead>-<effort>[-fast]-sidekick-<sidekick>` into its parts.
 * Lead effort is required; sidekick specs may carry their own effort and
 * speed suffixes (e.g. `gpt-6-luna-high-priority`, `swe-2-medium`, `glm-5-2`
 * with neither). Returns undefined for shapes the parser can't prove.
 */
export function parseDevinFusionModelUid(uid: string):
  | {
      lead: string;
      leadEffort: string;
      fast: boolean;
      sidekick: string;
      sidekickSpec: string;
    }
  | undefined {
  const trimmed = uid.trim();
  const splitAt = trimmed.indexOf("-sidekick-");
  if (!trimmed.startsWith("fusion-") || splitAt < 0) return undefined;
  const leadPart = trimmed.slice("fusion-".length, splitAt);
  const sidekickSpec = trimmed.slice(splitAt + "-sidekick-".length);
  if (!leadPart || !sidekickSpec) return undefined;

  const fast = leadPart.endsWith("-fast");
  const leadNoSpeed = fast ? leadPart.slice(0, -"-fast".length) : leadPart;
  const effortMatch = leadNoSpeed.match(FUSION_EFFORT_SUFFIX);
  if (!effortMatch) return undefined;
  const lead = leadNoSpeed.slice(0, leadNoSpeed.length - effortMatch[0].length);
  if (!lead) return undefined;

  return { lead, leadEffort: effortMatch[1]!, fast, sidekick: sidekickSpec, sidekickSpec };
}

function humanizeDevinModelId(id: string, familyLabels: DevinFamilyLabels): string {
  const known = familyLabels.get(id);
  if (known) return known;
  return id
    .split(/[-_]/u)
    .filter(Boolean)
    .map((part) => (/^\d/.test(part) || part.length <= 2 ? part.toUpperCase() : capitalize(part)))
    .join(" ");
}

function buildFusionSidekickLabel(spec: string, familyLabels: DevinFamilyLabels): string {
  const speedMatch = spec.match(FUSION_SPEED_SUFFIX);
  const withoutSpeed = speedMatch ? spec.slice(0, -speedMatch[0].length) : spec;
  const effortMatch = withoutSpeed.match(FUSION_EFFORT_SUFFIX);
  const model = effortMatch ? withoutSpeed.slice(0, -effortMatch[0].length) : withoutSpeed;
  const parts = [humanizeDevinModelId(model, familyLabels)];
  if (effortMatch)
    parts.push(DEVIN_REASONING_LABELS[effortMatch[1]!] ?? capitalize(effortMatch[1]!));
  if (speedMatch) parts.push(DEVIN_SPEED_LABELS[speedMatch[1]!] ?? capitalize(speedMatch[1]!));
  return parts.join(" ");
}

/**
 * Build the single `fusion` ServerProviderModel from the fusion family.
 * Emits Lead / Effort / Sidekick selects plus a Fast Mode boolean, and the
 * `optionVariants` table mapping each valid combination to its exact UID.
 * Malformed variants are skipped individually; if none parse, the family is
 * omitted rather than exposed as a misleading generic row.
 */
function buildDevinFusionModel(input: {
  family: typeof DevinModelFamily.Type;
  familyLabels: DevinFamilyLabels;
  subProvider: string;
}): ServerProviderModel | undefined {
  const { family, familyLabels, subProvider } = input;

  const leadIds: string[] = [];
  const leadEfforts = new Map<string, string>(); // effort id -> label
  const sidekickSpecs: string[] = [];
  const variants: ProviderOptionVariant[] = [];
  const pricingByVariant = new Map<string, ModelPricing>();
  const seenUids = new Set<string>();
  let contextWindowTokens: number | undefined;
  let contextWindowConflict = false;
  let maxOutputTokens: number | undefined;
  let maxOutputConflict = false;
  let defaultPricing: ModelPricing | undefined;
  let costTier: string | undefined;
  let badge: "new" | "beta" | undefined;

  for (const variant of family.variants) {
    const uid = variant.model_uid.trim();
    if (!uid || seenUids.has(uid)) continue;
    const parsed = parseDevinFusionModelUid(uid);
    if (!parsed) continue;
    seenUids.add(uid);

    const rawVariant = variant as unknown as Record<string, unknown>;
    const pricing = parseDevinVariantPricing(rawVariant);
    if (pricing) pricingByVariant.set(uid, pricing);
    if (defaultPricing === undefined) defaultPricing = pricing;
    if (costTier === undefined) costTier = variantCostTier(rawVariant);
    if (badge === undefined) badge = variantBadge(rawVariant);
    const variantContext = variantContextWindowTokens(rawVariant);
    if (variantContext !== undefined && !contextWindowConflict) {
      // Only trust a context size every variant agrees on; Fusion pairs two
      // models and a mixed value would misreport the lead's limit.
      if (contextWindowTokens === undefined) {
        contextWindowTokens = variantContext;
      } else if (contextWindowTokens !== variantContext) {
        contextWindowTokens = undefined;
        contextWindowConflict = true;
      }
    }
    const variantMaxOutput = variantMaxOutputTokens(rawVariant);
    if (variantMaxOutput !== undefined && !maxOutputConflict) {
      if (maxOutputTokens === undefined) {
        maxOutputTokens = variantMaxOutput;
      } else if (maxOutputTokens !== variantMaxOutput) {
        maxOutputTokens = undefined;
        maxOutputConflict = true;
      }
    }

    if (!leadIds.includes(parsed.lead)) leadIds.push(parsed.lead);
    if (!leadEfforts.has(parsed.leadEffort)) {
      leadEfforts.set(
        parsed.leadEffort,
        DEVIN_REASONING_LABELS[parsed.leadEffort] ?? capitalize(parsed.leadEffort),
      );
    }
    if (!sidekickSpecs.includes(parsed.sidekickSpec)) sidekickSpecs.push(parsed.sidekickSpec);

    variants.push({
      model: uid,
      selections: [
        { id: "lead", value: parsed.lead },
        { id: "effort", value: parsed.leadEffort },
        { id: "sidekick", value: parsed.sidekickSpec },
        { id: "fastMode", value: parsed.fast },
      ],
    });
  }

  if (variants.length === 0) return undefined;

  const defaults = variants[0]!.selections;
  const defaultValue = (id: string) => defaults.find((s) => s.id === id)?.value;

  const leadDescriptor: SelectProviderOptionDescriptor = {
    id: "lead",
    label: "Lead",
    type: "select",
    options: leadIds.map((lead) => ({
      id: lead,
      label: humanizeDevinModelId(lead, familyLabels),
      ...(lead === defaultValue("lead") ? { isDefault: true } : {}),
    })),
  };
  const effortOrder = [...DEVIN_REASONING_LEVELS];
  const effortDescriptor: SelectProviderOptionDescriptor = {
    id: "effort",
    label: "Effort",
    type: "select",
    options: [...leadEfforts.entries()]
      .sort(([a], [b]) => {
        const ai = effortOrder.indexOf(a as (typeof effortOrder)[number]);
        const bi = effortOrder.indexOf(b as (typeof effortOrder)[number]);
        return (ai === -1 ? effortOrder.length : ai) - (bi === -1 ? effortOrder.length : bi);
      })
      .map(([id, label]) => ({
        id,
        label,
        ...(id === defaultValue("effort") ? { isDefault: true } : {}),
      })),
  };
  const sidekickDescriptor: SelectProviderOptionDescriptor = {
    id: "sidekick",
    label: "Sidekick",
    type: "select",
    options: sidekickSpecs.map((spec) => ({
      id: spec,
      label: buildFusionSidekickLabel(spec, familyLabels),
      ...(spec === defaultValue("sidekick") ? { isDefault: true } : {}),
    })),
  };
  const descriptors: ProviderOptionDescriptor[] = [
    leadDescriptor,
    effortDescriptor,
    sidekickDescriptor,
  ];
  if (
    variants.some((variant) =>
      variant.selections.some((s) => s.id === "fastMode" && s.value === true),
    )
  ) {
    descriptors.push({
      id: "fastMode",
      label: "Fast Mode",
      type: "boolean",
      currentValue: defaultValue("fastMode") === true,
    });
  }

  return {
    slug: FUSION_FAMILY_UID,
    name: "Fusion",
    subProvider,
    isCustom: false,
    capabilities: createModelCapabilities({
      optionDescriptors: descriptors,
      optionVariants: variants,
    }),
    ...(badge ? { badge } : {}),
    ...(costTier ? { costTier } : {}),
    ...(defaultPricing ? { pricing: defaultPricing } : {}),
    ...(pricingByVariant.size > 0
      ? { pricingByVariant: modelPricingRecord(pricingByVariant) }
      : {}),
    ...(contextWindowTokens !== undefined ? { contextWindowTokens } : {}),
    ...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
  } satisfies ServerProviderModel;
}

export function buildDevinModelsFromPayload(
  payload: typeof DevinModelsPayload.Type,
): ReadonlyArray<ServerProviderModel> {
  const seen = new Set<string>();
  const models: ServerProviderModel[] = [];
  const familyLabels: DevinFamilyLabels = new Map(
    payload.families.map((family) => [family.family_uid, family.family_label]),
  );

  for (const family of payload.families) {
    const subProvider = family.family_label.trim() || family.family_uid.trim();
    const familyAliases = [
      ...(family.slug?.trim() ? [family.slug.trim()] : []),
      ...(family.aliases ?? []).map((alias) => alias.trim()).filter(Boolean),
    ];
    if (family.family_uid === FUSION_FAMILY_UID) {
      const fusionModel = buildDevinFusionModel({ family, familyLabels, subProvider });
      if (fusionModel && !seen.has(fusionModel.slug)) {
        seen.add(fusionModel.slug);
        models.push({
          ...fusionModel,
          ...(familyAliases.length > 0 ? { aliases: familyAliases } : {}),
        });
      }
      continue;
    }
    const parsedFamilyVariants = family.variants
      .map((candidate) => ({
        uid: candidate.model_uid.trim(),
        label: candidate.label.trim(),
        parsed: parseDevinModelUid(candidate.model_uid),
      }))
      .filter((candidate) => candidate.uid.length > 0 && candidate.label.length > 0);
    const familyHasReasoningVariants =
      parsedFamilyVariants.length > 1 &&
      parsedFamilyVariants.some(
        (candidate) =>
          candidate.parsed.reasoning !== undefined || labelHasReasoningSignal(candidate.label),
      );
    // A few Devin families use opaque/private UIDs that do not share a common
    // suffix (for example MODEL_PRIVATE_2 + MODEL_PRIVATE_3 for a
    // no-thinking/thinking pair). The unsuffixed variant is the best parent
    // slug when present; otherwise use the first parsed base.
    const familyGroupBase =
      parsedFamilyVariants.find((candidate) => candidate.parsed.reasoning === undefined)?.parsed
        .base ?? parsedFamilyVariants[0]?.parsed.base;

    // Variants that share a base (+ speed tier) but differ only in reasoning
    // level collapse into one selectable model. Track them here keyed by the
    // group key, then emit a single ServerProviderModel with a `reasoning`
    // option descriptor per group.
    type DevinModelGroup = {
      base: string;
      reasoningLevels: Map<string, string>;
      /** The first reasoning variant reported by Devin, or a reasoning
       * level inferred from the family's unsuffixed canonical entry. */
      firstReasoning?: string;
      defaultReasoning?: string;
      /** Some families use the unsuffixed UID for their no-thinking variant. */
      hasCanonicalNoReasoning?: boolean;
      /** Concrete UIDs for families whose reasoning variants are opaque. */
      reasoningUids: Map<string, string>;
      usesExplicitReasoningUids?: boolean;
      speeds: Set<string>;
      contexts: Set<string>;
      /** Largest explicit context size (in tokens) any variant reported. */
      maxContextTokens?: number;
      defaultContextWindow?: string;
      badge?: "new" | "beta";
      costTier?: string;
      pricingByVariant: Map<string, ModelPricing>;
      maxOutputByVariant: Map<string, number>;
    };
    const groups = new Map<string, DevinModelGroup>();

    for (const variant of family.variants) {
      const uid = variant.model_uid.trim();
      const label = variant.label.trim();
      if (!uid || !label) continue;

      const parsed = parseDevinModelUid(uid);
      const rawVariant = variant as unknown as Record<string, unknown>;
      const explicitContextTokens =
        variantContextWindowTokens(rawVariant) ??
        (parsed.contextWindow ? parseContext(parsed.contextWindow) * 1_000 : undefined);
      const badge = variantBadge(rawVariant);
      const costTier = variantCostTier(rawVariant);
      const maxOutputTokens = variantMaxOutputTokens(rawVariant);
      const variantPricing = pricingWithContext(
        parseDevinVariantPricing(rawVariant),
        explicitContextTokens,
      );
      if (parsed.reasoning === undefined) {
        if (familyHasReasoningVariants) {
          const key = familyGroupBase ?? devinModelGroupKey(parsed);
          const group =
            groups.get(key) ??
            (() => {
              const defaultContext = DEVIN_DEFAULT_CONTEXT_WINDOWS[parsed.base];
              const created: DevinModelGroup = {
                base: key,
                reasoningLevels: new Map<string, string>(),
                reasoningUids: new Map<string, string>(),
                speeds: new Set(["standard"]),
                contexts: new Set<string>(),
                ...(defaultContext ? { defaultContextWindow: defaultContext } : {}),
                pricingByVariant: new Map<string, ModelPricing>(),
                maxOutputByVariant: new Map<string, number>(),
              };
              if (defaultContext) created.contexts.add(defaultContext);
              if (variantPricing) created.pricingByVariant.set(uid, variantPricing);
              if (maxOutputTokens !== undefined)
                created.maxOutputByVariant.set(uid, maxOutputTokens);
              groups.set(key, created);
              return created;
            })();
          if (explicitContextTokens !== undefined) {
            group.maxContextTokens = Math.max(group.maxContextTokens ?? 0, explicitContextTokens);
          }
          if (badge && group.badge === undefined) group.badge = badge;
          if (costTier && group.costTier === undefined) group.costTier = costTier;
          if (variantPricing) group.pricingByVariant.set(uid, variantPricing);
          if (maxOutputTokens !== undefined) group.maxOutputByVariant.set(uid, maxOutputTokens);
          const contextOption = formatContextWindowOption(explicitContextTokens ?? 0);
          if (contextOption) group.contexts.add(contextOption);
          const inferredReasoning = inferReasoningFromLabel(label);
          group.reasoningUids.set(inferredReasoning, uid);
          if (parsed.base !== group.base) group.usesExplicitReasoningUids = true;
          if (inferredReasoning === "none") {
            group.hasCanonicalNoReasoning = true;
          }
          group.reasoningLevels.set(
            inferredReasoning,
            DEVIN_REASONING_LABELS[inferredReasoning] ?? capitalize(inferredReasoning),
          );
          // Some families (notably GLM-5.2) use an unsuffixed UID for their
          // canonical/default reasoning level. Preserve that signal instead
          // of letting the alphabetically/effort-sorted options choose None.
          if (
            inferredReasoning !== "none" &&
            parsed.base === group.base &&
            group.defaultReasoning === undefined
          ) {
            group.defaultReasoning = inferredReasoning;
          }
          if (parsed.contextWindow) group.contexts.add(parsed.contextWindow);
          if (parsed.contextWindow && group.defaultContextWindow === undefined) {
            group.defaultContextWindow = parsed.contextWindow;
          }
          continue;
        }
        // No reasoning suffix — a standalone model, emitted as-is.
        if (seen.has(uid)) continue;
        seen.add(uid);
        const contextWindowTokens =
          variantPricing?.contextWindowTokens ??
          explicitContextTokens ??
          inferDevinContextWindowTokens(uid);
        models.push({
          slug: uid,
          name: label,
          subProvider,
          isCustom: false,
          ...(uid === "adaptive" ? { isDefault: true } : {}),
          capabilities: devinModelCapabilities(uid),
          ...(badge ? { badge } : {}),
          ...(costTier ? { costTier } : {}),
          ...(familyAliases.length > 0 ? { aliases: familyAliases } : {}),
          ...(variantPricing ? { pricing: variantPricing } : {}),
          ...(contextWindowTokens !== undefined ? { contextWindowTokens } : {}),
          ...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
        } satisfies ServerProviderModel);
        continue;
      }

      const key = familyGroupBase ?? devinModelGroupKey(parsed);
      const group =
        groups.get(key) ??
        (() => {
          const defaultContext = DEVIN_DEFAULT_CONTEXT_WINDOWS[parsed.base] ?? parsed.contextWindow;
          const created: DevinModelGroup = {
            base: key,
            reasoningLevels: new Map<string, string>(),
            reasoningUids: new Map<string, string>(),
            speeds: new Set([parsed.speed ?? "standard"]),
            contexts: new Set(parsed.contextWindow ? [parsed.contextWindow] : []),
            ...(defaultContext ? { defaultContextWindow: defaultContext } : {}),
            pricingByVariant: new Map<string, ModelPricing>(),
            maxOutputByVariant: new Map<string, number>(),
          };
          if (defaultContext) created.contexts.add(defaultContext);
          groups.set(key, created);
          return created;
        })();
      if (explicitContextTokens !== undefined) {
        group.maxContextTokens = Math.max(group.maxContextTokens ?? 0, explicitContextTokens);
      }
      if (badge && group.badge === undefined) group.badge = badge;
      if (costTier && group.costTier === undefined) group.costTier = costTier;
      if (variantPricing) group.pricingByVariant.set(uid, variantPricing);
      if (maxOutputTokens !== undefined) group.maxOutputByVariant.set(uid, maxOutputTokens);
      const contextOption = formatContextWindowOption(explicitContextTokens ?? 0);
      if (contextOption) group.contexts.add(contextOption);
      if (parsed.reasoning !== undefined && !group.reasoningLevels.has(parsed.reasoning)) {
        const reasoning = parsed.reasoning;
        if (!reasoning) continue;
        if (group.firstReasoning === undefined) group.firstReasoning = reasoning;
        group.reasoningLevels.set(
          reasoning,
          DEVIN_REASONING_LABELS[reasoning] ?? capitalize(reasoning),
        );
        group.reasoningUids.set(reasoning, uid);
        if (parsed.base !== group.base) group.usesExplicitReasoningUids = true;
      }
      group.speeds.add(parsed.speed ?? "standard");
      if (parsed.contextWindow) group.contexts.add(parsed.contextWindow);
      if (parsed.contextWindow && group.defaultContextWindow === undefined) {
        group.defaultContextWindow = parsed.contextWindow;
      }
    }

    for (const [key, group] of groups) {
      if (seen.has(key)) continue;
      seen.add(key);

      const orderedLevels = DEVIN_REASONING_LEVELS.filter((level) =>
        group.reasoningLevels.has(level),
      );
      const defaultReasoning =
        group.defaultReasoning ??
        (group.hasCanonicalNoReasoning
          ? "none"
          : orderedLevels.includes("medium")
            ? "medium"
            : group.firstReasoning) ??
        orderedLevels[0];
      const choices: ProviderOptionChoice[] = orderedLevels.map((level) => {
        const concreteUid = group.reasoningUids.get(level);
        const optionId =
          group.usesExplicitReasoningUids &&
          concreteUid &&
          parseDevinModelUid(concreteUid).base !== group.base
            ? `__uid:${concreteUid}`
            : level;
        return {
          id: optionId,
          label: group.reasoningLevels.get(level)!,
          ...(level === defaultReasoning ? { isDefault: true } : {}),
        };
      });

      const reasoningDescriptor: SelectProviderOptionDescriptor = {
        id: "reasoning",
        label: "Reasoning",
        type: "select",
        options: choices,
      };

      const speedValues = ["standard", "fast", "priority"].filter((value) =>
        group.speeds.has(value),
      );
      const contextValues = [...group.contexts].sort((a, b) => parseContext(a) - parseContext(b));
      const optionDescriptors: SelectProviderOptionDescriptor[] = [reasoningDescriptor];
      if (speedValues.length > 1) {
        optionDescriptors.push({
          id: "speed",
          label: "Speed",
          type: "select",
          options: speedValues.map((value) => ({
            id: value,
            label: DEVIN_SPEED_LABELS[value] ?? capitalize(value),
            ...(value === "standard" ? { isDefault: true } : {}),
          })),
        });
      }
      if (contextValues.length > 1) {
        optionDescriptors.push({
          id: "contextWindow",
          label: "Context window",
          type: "select",
          options: contextValues.map((value, index) => ({
            id: value,
            label: value.toUpperCase(),
            ...(value === (group.defaultContextWindow ?? contextValues[0] ?? "") ||
            (group.defaultContextWindow === undefined && index === 0)
              ? { isDefault: true }
              : {}),
          })),
        });
      }

      const overrides = DEVIN_MODEL_INPUT_CAPABILITIES[group.base];
      const pricingEntries = group.pricingByVariant;
      const defaultPricing =
        [...pricingEntries.entries()].find(([uid]) => {
          const parsed = parseDevinModelUid(uid);
          return (
            (parsed.reasoning ?? "") === "medium" && (parsed.speed ?? "standard") === "standard"
          );
        })?.[1] ?? [...pricingEntries.values()][0];
      const pricingContextWindowTokens = [...pricingEntries.values()]
        .map((pricing) => pricing.contextWindowTokens)
        .filter((value): value is number => value !== undefined)
        .sort((left, right) => right - left)[0];
      const contextWindowTokens =
        group.maxContextTokens ??
        pricingContextWindowTokens ??
        defaultPricing?.contextWindowTokens ??
        inferDevinContextWindowTokens(group.base);
      // Output limits vary per reasoning level on some families; only surface
      // one when every reporting variant agrees on the same number.
      const uniqueMaxOutputs = new Set(group.maxOutputByVariant.values());
      const maxOutputTokens =
        uniqueMaxOutputs.size === 1 ? uniqueMaxOutputs.values().next().value : undefined;
      models.push({
        slug: key,
        name: subProvider,
        subProvider,
        isCustom: false,
        ...(key === "adaptive" ? { isDefault: true } : {}),
        capabilities: createModelCapabilities({
          optionDescriptors,
          ...overrides,
        }),
        ...(group.badge ? { badge: group.badge } : {}),
        ...(group.costTier ? { costTier: group.costTier } : {}),
        ...(familyAliases.length > 0 ? { aliases: familyAliases } : {}),
        ...(defaultPricing ? { pricing: defaultPricing } : {}),
        ...(modelPricingRecord(pricingEntries)
          ? { pricingByVariant: modelPricingRecord(pricingEntries) }
          : {}),
        ...(contextWindowTokens !== undefined ? { contextWindowTokens } : {}),
        ...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
      } satisfies ServerProviderModel);
    }
  }

  return models;
}

function looksUnauthenticated(output: string): boolean {
  const normalized = output.toLowerCase();
  return (
    normalized.includes("not authenticated") ||
    normalized.includes("not logged in") ||
    normalized.includes("log in") ||
    normalized.includes("login required")
  );
}

export const checkDevinProviderStatus = Effect.fn("checkDevinProviderStatus")(function* (
  settings: DevinSettings,
  environment?: NodeJS.ProcessEnv,
): Effect.fn.Return<
  ServerProviderDraft,
  never,
  ChildProcessSpawner.ChildProcessSpawner | Crypto.Crypto
> {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  const fallbackModels = providerModelsFromSettings([], settings.customModels, EMPTY_CAPABILITIES);

  if (!settings.enabled) {
    return yield* buildInitialDevinProviderSnapshot(settings);
  }

  const versionResult = yield* runDevinCommand(settings, ["--version"], environment).pipe(
    Effect.timeoutOption(VERSION_PROBE_TIMEOUT_MS),
    Effect.result,
  );
  if (Result.isFailure(versionResult)) {
    const missing = isCommandMissingCause(versionResult.failure);
    return buildServerProvider({
      presentation: DEVIN_PRESENTATION,
      enabled: true,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: !missing,
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: missing
          ? "Devin CLI (`devin`) is not installed or not on PATH."
          : "Failed to execute the Devin CLI health check.",
      },
    });
  }
  if (Option.isNone(versionResult.success)) {
    return buildServerProvider({
      presentation: DEVIN_PRESENTATION,
      enabled: true,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: "Devin CLI timed out while checking its version.",
      },
    });
  }

  const versionOutput = versionResult.success.value;
  const version = parseGenericCliVersion(`${versionOutput.stdout}\n${versionOutput.stderr}`);
  if (versionOutput.code !== 0) {
    return buildServerProvider({
      presentation: DEVIN_PRESENTATION,
      enabled: true,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version,
        status: "error",
        auth: { status: "unknown" },
        message: "Devin CLI is installed but failed to run.",
      },
    });
  }

  const modelResult = yield* runDevinCommand(
    settings,
    ["models", "list", "--format", "json"],
    environment,
  ).pipe(Effect.timeoutOption(MODEL_PROBE_TIMEOUT_MS), Effect.result);

  if (Result.isFailure(modelResult) || Option.isNone(modelResult.success)) {
    return buildServerProvider({
      presentation: DEVIN_PRESENTATION,
      enabled: true,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version,
        status: "warning",
        auth: { status: "unknown" },
        message: "Devin is installed, but model discovery failed or timed out.",
      },
    });
  }

  const output = modelResult.success.value;
  if (output.code !== 0) {
    const unauthenticated = looksUnauthenticated(`${output.stdout}\n${output.stderr}`);
    return buildServerProvider({
      presentation: DEVIN_PRESENTATION,
      enabled: true,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version,
        status: "error",
        auth: { status: unauthenticated ? "unauthenticated" : "unknown" },
        message: unauthenticated
          ? "Devin CLI is not authenticated. Run `devin auth login`."
          : "Devin model discovery failed.",
      },
    });
  }

  let decoded = yield* decodeDevinModels(output.stdout).pipe(Effect.option);
  // `--format json` was added after the first Devin CLI releases. If an older
  // binary ignores the flag (or returns a different JSON envelope), retry the
  // same probe without it and retain the pricing/context details from the
  // human-readable catalog.
  if (Option.isNone(decoded)) {
    const humanResult = yield* runDevinCommand(settings, ["models", "list"], environment).pipe(
      Effect.timeoutOption(MODEL_PROBE_TIMEOUT_MS),
      Effect.result,
    );
    if (Result.isSuccess(humanResult) && Option.isSome(humanResult.success)) {
      const humanOutput = humanResult.success.value;
      if (humanOutput.code === 0) {
        const parsedHuman = parseDevinHumanModelList(humanOutput.stdout);
        if (parsedHuman) decoded = Option.some(parsedHuman);
      }
    }
  }
  if (Option.isNone(decoded)) {
    return buildServerProvider({
      presentation: DEVIN_PRESENTATION,
      enabled: true,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version,
        status: "warning",
        auth: { status: "authenticated" },
        message: "Devin returned an unrecognized model catalog.",
      },
    });
  }

  return buildServerProvider({
    presentation: DEVIN_PRESENTATION,
    enabled: true,
    checkedAt,
    models: providerModelsFromSettings(
      buildDevinModelsFromPayload(decoded.value),
      settings.customModels,
      EMPTY_CAPABILITIES,
    ),
    probe: {
      installed: true,
      version,
      status: "ready",
      auth: { status: "authenticated" },
    },
  });
});
