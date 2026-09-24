import {
  type DevinSettings,
  PROVIDER_VARIANT_SELECTION_ID,
  type ProviderOptionSelection,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import type * as EffectAcpErrors from "effect-acp/errors";
import type * as EffectAcpSchema from "effect-acp/schema";

import * as AcpSessionRuntime from "./AcpSessionRuntime.ts";
import { collectSessionConfigOptionValues, findSessionConfigOption } from "./AcpRuntimeModel.ts";
import {
  devinModelGroupKey,
  parseDevinFusionModelUid,
  parseDevinModelUid,
} from "../Layers/DevinProvider.ts";

export { inferDevinContextWindowTokens } from "../Layers/DevinProvider.ts";

const LOWER_SPEED_SUFFIX = /-(fast|priority)$/;
const UPPER_SPEED_SUFFIX = /_(FAST|PRIORITY)$/;

function stripTrailingSpeed(slug: string): { base: string; speed: string } | undefined {
  const lower = slug.match(LOWER_SPEED_SUFFIX);
  if (lower) {
    return { base: slug.slice(0, slug.length - lower[0].length), speed: lower[1]! };
  }
  const upper = slug.match(UPPER_SPEED_SUFFIX);
  if (upper) {
    return { base: slug.slice(0, slug.length - upper[0].length), speed: upper[1]!.toLowerCase() };
  }
  return undefined;
}

/**
 * The slice of Devin settings that affects ACP process spawn. All optional so
 * callers (adapter, background text generation) can pass only what applies.
 */
type DevinAcpRuntimeSettings = Partial<
  Pick<DevinSettings, "binaryPath" | "agentType" | "refusalFallback" | "cloud">
>;

function parseRefusalFallbackModels(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function buildDevinAcpArgs(settings: DevinAcpRuntimeSettings | null | undefined): string[] {
  const args = ["acp"];
  const agentType = settings?.agentType;
  if (agentType && agentType !== "default") {
    args.push("--agent-type", agentType);
  }
  for (const model of parseRefusalFallbackModels(settings?.refusalFallback)) {
    args.push("--refusal-fallback", model);
  }
  if (settings?.cloud === true) {
    args.push("--cloud");
  }
  return args;
}

export const DEVIN_ACP_CLIENT_CAPABILITIES = {
  _meta: {
    "cognition.ai/requestDiagnostics": true,
  },
} satisfies NonNullable<EffectAcpSchema.InitializeRequest["clientCapabilities"]>;

export interface DevinAcpRuntimeInput extends Omit<
  AcpSessionRuntime.AcpSessionRuntimeOptions,
  "authMethodId" | "clientCapabilities" | "spawn"
> {
  readonly childProcessSpawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly devinSettings: DevinAcpRuntimeSettings | null | undefined;
  readonly environment?: NodeJS.ProcessEnv;
}

export function buildDevinAcpSpawnInput(
  devinSettings: DevinAcpRuntimeSettings | null | undefined,
  cwd: string,
  environment?: NodeJS.ProcessEnv,
): AcpSessionRuntime.AcpSpawnInput {
  return {
    command: devinSettings?.binaryPath || "devin",
    args: buildDevinAcpArgs(devinSettings),
    cwd,
    ...(environment ? { env: environment } : {}),
  };
}

export const makeDevinAcpRuntime = (
  input: DevinAcpRuntimeInput,
): Effect.Effect<
  AcpSessionRuntime.AcpSessionRuntime["Service"],
  EffectAcpErrors.AcpError,
  Crypto.Crypto | Scope.Scope
> =>
  Effect.gen(function* () {
    const acpContext = yield* Layer.build(
      AcpSessionRuntime.layer({
        ...input,
        spawn: buildDevinAcpSpawnInput(input.devinSettings, input.cwd, input.environment),
        clientCapabilities: DEVIN_ACP_CLIENT_CAPABILITIES,
      }).pipe(
        Layer.provide(
          Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, input.childProcessSpawner),
        ),
      ),
    );
    return yield* Effect.service(AcpSessionRuntime.AcpSessionRuntime).pipe(
      Effect.provide(acpContext),
    );
  });

export interface DevinAcpModelSelectionErrorContext {
  readonly cause: EffectAcpErrors.AcpError;
  readonly step: "set-config-option";
  readonly configId: string;
}

function sessionModelOptionValues(
  configOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption>,
): ReadonlyArray<string> {
  const option =
    configOptions.find((entry) => entry.category === "model") ??
    findSessionConfigOption(configOptions, "model");
  return option === undefined ? [] : collectSessionConfigOptionValues(option);
}

/**
 * The `devin models list` catalog is broader than the `model` enum a session
 * advertises — e.g. `swe-2-max` lists but only `swe-2-high` is selectable,
 * the same aliasing the CLI's own `--model` resolution performs. When the
 * resolved UID is absent from the enum, degrade to the closest allowed
 * variant instead of failing the session. Returns [] when the UID is already
 * allowed or no enum was advertised.
 */
export function resolveDevinSessionModelFallbacks(
  resolvedUid: string,
  allowedValues: ReadonlyArray<string>,
): ReadonlyArray<string> {
  if (allowedValues.length === 0 || allowedValues.includes(resolvedUid)) {
    return [];
  }
  const fusion = parseDevinFusionModelUid(resolvedUid);
  if (fusion !== undefined) {
    const allowed = allowedValues.flatMap((value) => {
      const parsed = parseDevinFusionModelUid(value);
      return parsed === undefined ? [] : [{ value, parsed }];
    });
    const chosen = new Set<string>();
    const pick = (
      pred: (parsed: NonNullable<ReturnType<typeof parseDevinFusionModelUid>>) => boolean,
    ) => {
      const hit = allowed.find(
        (candidate) => !chosen.has(candidate.value) && pred(candidate.parsed),
      )?.value;
      if (hit !== undefined) chosen.add(hit);
      return hit;
    };
    const sidekickGroup = devinModelGroupKey(parseDevinModelUid(fusion.sidekickSpec));
    return [
      // Same lead + sidekick, lead speed relaxed — `-fast` fusion variants
      // are catalogued but never offered by the session enum.
      pick(
        (f) =>
          f.lead === fusion.lead &&
          f.leadEffort === fusion.leadEffort &&
          f.sidekickSpec === fusion.sidekickSpec,
      ),
      // Lead effort relaxed.
      pick((f) => f.lead === fusion.lead && f.sidekickSpec === fusion.sidekickSpec),
      // Sidekick tier relaxed (e.g. `swe-2-medium` -> `swe-2-high`).
      pick(
        (f) =>
          f.lead === fusion.lead &&
          devinModelGroupKey(parseDevinModelUid(f.sidekickSpec)) === sidekickGroup,
      ),
    ].filter((value): value is string => value !== undefined);
  }
  const parsed = parseDevinModelUid(resolvedUid);
  const group = devinModelGroupKey(parsed);
  const family = allowedValues
    .flatMap((value, index) => {
      if (parseDevinFusionModelUid(value) !== undefined) return [];
      const candidate = parseDevinModelUid(value);
      if (devinModelGroupKey(candidate) !== group) return [];
      let score = 0;
      if (candidate.contextWindow === parsed.contextWindow) score += 4;
      if (candidate.reasoning === parsed.reasoning) score += 2;
      return [{ value, score, index }];
    })
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map(({ value }) => value);
  return family;
}

/**
 * The model UID that describes a session's effective model after applying a
 * `thought_level` — e.g. `swe-2-high` + `max` is what `models list` calls
 * `swe-2-max`, and `glm-5-2-1m` + `max` is `glm-5-2-max-1m`.
 */
export function resolveDevinEffectiveModelUid(appliedUid: string, thoughtLevel: string): string {
  const fusion = parseDevinFusionModelUid(appliedUid);
  if (fusion !== undefined) {
    return `fusion-${fusion.lead}-${thoughtLevel}${fusion.fast ? "-fast" : ""}-sidekick-${fusion.sidekickSpec}`;
  }
  const parsed = parseDevinModelUid(appliedUid);
  const selections: ProviderOptionSelection[] = [
    { id: "reasoning", value: thoughtLevel },
    ...(parsed.contextWindow ? [{ id: "contextWindow", value: parsed.contextWindow }] : []),
  ];
  return resolveDevinModelUid(appliedUid, selections);
}

function thoughtLevelOption(
  configOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption>,
): EffectAcpSchema.SessionConfigOption | undefined {
  const option =
    configOptions.find((entry) => entry.category === "thought_level") ??
    findSessionConfigOption(configOptions, "thought_level");
  return option?.type === "select" ? option : undefined;
}

/**
 * Applies the model selection and resolves to the UID describing the
 * session's effective model. Devin's ACP session splits model selection
 * across two config options: the `model` enum carries one member per family
 * (e.g. `swe-2-high`), while `thought_level` carries the family's effort
 * tier (`medium|high|max` for SWE-2, up to `low|…|xhigh|max` elsewhere).
 * `swe-2-max` therefore applies as `model: swe-2-high` + `thought_level: max`.
 * Variants the enum omits fall back to the closest same-family member, and
 * qualifiers with no config channel (speed `-fast`) degrade silently, as the
 * CLI's own `--model` resolution does.
 */
export function applyDevinAcpModelSelection<E>(input: {
  readonly runtime: Pick<
    AcpSessionRuntime.AcpSessionRuntime["Service"],
    "getConfigOptions" | "setConfigOption" | "setModel"
  >;
  readonly model: string | null | undefined;
  readonly selections?: ReadonlyArray<ProviderOptionSelection> | null | undefined;
  readonly mapError: (context: DevinAcpModelSelectionErrorContext) => E;
}): Effect.Effect<string, E> {
  const model = resolveDevinModelUid(input.model, input.selections);
  const reasoning = input.selections?.find((option) => option.id === "reasoning")?.value;
  const context = input.selections?.find((option) => option.id === "contextWindow")?.value;
  const speed = input.selections?.find((option) => option.id === "speed")?.value;
  const base = resolveDevinAcpBaseModelId(input.model);
  const isUpper = base.includes("_") && /[A-Z]/.test(base);
  const separator = isUpper ? "_" : "-";
  const contextSuffix =
    typeof context === "string" && context.trim()
      ? `${separator}${isUpper ? context.toUpperCase() : context.toLowerCase()}`
      : "";
  const contextFallbacks =
    reasoning === "none" && (speed === undefined || speed === "standard")
      ? [contextSuffix.length > 0 ? `${base}${contextSuffix}` : null, base].filter(
          (candidate): candidate is string => candidate !== null && candidate !== model,
        )
      : [];
  const attempt = (
    candidates: ReadonlyArray<string>,
  ): Effect.Effect<string, EffectAcpErrors.AcpError> => {
    const [first, ...rest] = candidates;
    if (first === undefined) {
      return Effect.die("applyDevinAcpModelSelection: empty candidate list");
    }
    return input.runtime.setModel(first).pipe(
      Effect.as(first),
      Effect.catch((cause) => (rest.length === 0 ? Effect.fail(cause) : attempt(rest))),
    );
  };
  // The effort tier the resolved UID asks for: a fusion variant's lead
  // effort, otherwise the reasoning suffix. Applied through the session's
  // `thought_level` option when that option advertises it.
  const desiredTier =
    parseDevinFusionModelUid(model)?.leadEffort ?? parseDevinModelUid(model).reasoning;
  return Effect.flatMap(input.runtime.getConfigOptions, (configOptions) =>
    attempt(
      [
        model,
        ...resolveDevinSessionModelFallbacks(model, sessionModelOptionValues(configOptions)),
        ...contextFallbacks,
      ].filter((value, index, all) => all.indexOf(value) === index),
    ),
  ).pipe(
    Effect.mapError((cause) =>
      input.mapError({
        cause,
        step: "set-config-option",
        configId: "model",
      }),
    ),
    Effect.flatMap((appliedUid) => {
      if (desiredTier === undefined) {
        return Effect.succeed(appliedUid);
      }
      return Effect.flatMap(input.runtime.getConfigOptions, (configOptions) => {
        const option = thoughtLevelOption(configOptions);
        if (
          option === undefined ||
          !collectSessionConfigOptionValues(option).includes(desiredTier)
        ) {
          return Effect.succeed(appliedUid);
        }
        return input.runtime.setConfigOption(option.id, desiredTier).pipe(
          Effect.mapError((cause) =>
            input.mapError({
              cause,
              step: "set-config-option",
              configId: option.id,
            }),
          ),
          Effect.as(resolveDevinEffectiveModelUid(appliedUid, desiredTier)),
        );
      });
    }),
  );
}

/**
 * Returns the base model slug (the group key, with no reasoning level) used
 * to decide whether a model change requires an ACP session restart. Changing
 * only the reasoning level is a config-option tweak, not a model swap.
 */
export function resolveDevinAcpBaseModelId(model: string | null | undefined): string {
  const trimmed = model?.trim();
  if (!trimmed) return "adaptive";
  // Fusion is one stable model row; every concrete `fusion-*` UID maps back
  // to it so changing dependent options never looks like a model swap.
  if (trimmed === "fusion" || parseDevinFusionModelUid(trimmed) !== undefined) return "fusion";
  return devinModelGroupKey(parseDevinModelUid(trimmed));
}

/**
 * Recombines a base model slug with its `reasoning` option selection to form
 * the full model UID Devin's ACP backend expects.
 *
 * The base slug is the group key (e.g. `claude-opus-5` or
 * `claude-opus-5-fast`); the reasoning choice is inserted before any speed
 * tier so `claude-opus-5-fast` + `medium` → `claude-opus-5-medium-fast`.
 * Uppercase enum-style UIDs recombine with `_` separators and uppercased
 * suffixes: `MODEL_GPT_5_2` + `low` → `MODEL_GPT_5_2_LOW`.
 */
export function resolveDevinModelUid(
  model: string | null | undefined,
  options?: ReadonlyArray<ProviderOptionSelection> | null,
): string {
  // A resolved catalog variant carries its exact provider UID; dispatch it
  // verbatim rather than reconstructing from visible options (Fusion).
  const exactVariant = options?.find(
    (option) => option.id === PROVIDER_VARIANT_SELECTION_ID,
  )?.value;
  if (typeof exactVariant === "string" && exactVariant.trim()) {
    return exactVariant.trim();
  }
  const groupSlug = resolveDevinAcpBaseModelId(model);
  const reasoning = options?.find((option) => option.id === "reasoning")?.value;
  if (typeof reasoning !== "string" || !reasoning.trim()) {
    return groupSlug;
  }
  if (reasoning.startsWith("__uid:")) {
    const concreteUid = reasoning.slice("__uid:".length).trim();
    if (concreteUid.length > 0) return concreteUid;
  }
  // The group slug is `base + sep + speed` (or just base). Split the speed
  // tier off so the reasoning level can be inserted before it.
  const speedParts = stripTrailingSpeed(groupSlug);
  const base = speedParts?.base ?? groupSlug;
  const selectedSpeed = options?.find((option) => option.id === "speed")?.value;
  const speed =
    typeof selectedSpeed === "string" && selectedSpeed !== "standard"
      ? selectedSpeed
      : speedParts?.speed;
  const isUpper = base.includes("_") && /[A-Z]/.test(base);
  const sep = isUpper ? "_" : "-";
  const reasoningSuffix = isUpper ? reasoning.toUpperCase() : reasoning;
  const speedSuffix = speed ? (isUpper ? `_${speed.toUpperCase()}` : `-${speed}`) : "";
  const context = options?.find((option) => option.id === "contextWindow")?.value;
  // Devin's GLM family uses the unsuffixed UID for the 200K variants and
  // appends only the context suffix for 1M variants. The reasoning level is
  // encoded for None/Max, while High is the family default (`glm-5-2`).
  // It is never `glm-5-2-high-200k` (or another `-200k` UID).
  const isGlm52 = base.toLowerCase() === "glm-5-2";
  if (isGlm52 && (reasoning ?? "").toLowerCase() === "high") {
    return context === "1m" ? "glm-5-2-1m" : "glm-5-2";
  }
  if (isGlm52 && !speed && ["none", "max"].includes((reasoning ?? "").toLowerCase())) {
    const glmContextSuffix = context === "1m" ? "-1m" : "";
    return `glm-5-2-${reasoning!.toLowerCase()}${glmContextSuffix}`;
  }
  const contextSuffix =
    typeof context === "string" && context.trim()
      ? `${sep}${isUpper ? context.toUpperCase() : context.toLowerCase()}`
      : "";
  return `${base}${sep}${reasoningSuffix}${speedSuffix}${contextSuffix}`;
}
