import {
  type CustomModelSetting,
  MODEL_SLUG_ALIASES_BY_PROVIDER,
  ModelCapabilities,
  type ModelSelection,
  PROVIDER_VARIANT_SELECTION_ID,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderOptionDescriptor,
  type ProviderOptionSelection,
  type ProviderOptionVariant,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

const DEFAULT_PROVIDER_DRIVER_KIND = ProviderDriverKind.make("codex");

export interface SelectableModelOption {
  slug: string;
  name: string;
  aliases?: ReadonlyArray<string> | undefined;
}

export function createModelCapabilities(input: {
  optionDescriptors: ReadonlyArray<ProviderOptionDescriptor>;
  optionVariants?: ReadonlyArray<ProviderOptionVariant>;
  inputImages?: boolean;
  inputAudio?: boolean;
  inputFiles?: boolean;
}): ModelCapabilities {
  return {
    optionDescriptors: input.optionDescriptors.map(cloneDescriptor),
    ...(input.optionVariants && input.optionVariants.length > 0
      ? {
          optionVariants: input.optionVariants.map((variant) => ({
            model: variant.model,
            selections: cloneSelections(variant.selections),
          })),
        }
      : {}),
    ...(input.inputImages === false ? { inputImages: false } : {}),
    ...(input.inputAudio === false ? { inputAudio: false } : {}),
    ...(input.inputFiles === false ? { inputFiles: false } : {}),
  };
}

/**
 * Resolved input modalities for a model. Absent fields default to `true`
 * (supported) so providers that never populate them keep working. Text is
 * always supported and is not represented here.
 */
export interface ModelInputCapabilities {
  images: boolean;
  audio: boolean;
  files: boolean;
}

export function getModelInputCapabilities(
  caps: ModelCapabilities | null | undefined,
): ModelInputCapabilities {
  return {
    images: caps?.inputImages !== false,
    audio: caps?.inputAudio !== false,
    files: caps?.inputFiles !== false,
  };
}

function getRawSelectionValueById(
  selections: ReadonlyArray<ProviderOptionSelection> | null | undefined,
  id: string,
): string | boolean | undefined {
  const selection = selections?.find((candidate) => candidate.id === id);
  return selection?.value;
}

function getProviderOptionSelectionValue(
  selections: ReadonlyArray<ProviderOptionSelection> | null | undefined,
  id: string,
): string | boolean | undefined {
  return getRawSelectionValueById(selections, id);
}

export function getProviderOptionStringSelectionValue(
  selections: ReadonlyArray<ProviderOptionSelection> | null | undefined,
  id: string,
): string | undefined {
  const value = getProviderOptionSelectionValue(selections, id);
  return typeof value === "string" ? value : undefined;
}

export function getProviderOptionBooleanSelectionValue(
  selections: ReadonlyArray<ProviderOptionSelection> | null | undefined,
  id: string,
): boolean | undefined {
  const value = getProviderOptionSelectionValue(selections, id);
  return typeof value === "boolean" ? value : undefined;
}

export function getModelSelectionStringOptionValue(
  modelSelection: ModelSelection | null | undefined,
  id: string,
): string | undefined {
  return getProviderOptionStringSelectionValue(modelSelection?.options, id);
}

export function getModelSelectionBooleanOptionValue(
  modelSelection: ModelSelection | null | undefined,
  id: string,
): boolean | undefined {
  return getProviderOptionBooleanSelectionValue(modelSelection?.options, id);
}

function resolveDescriptorChoiceValue(
  descriptor: Extract<ProviderOptionDescriptor, { type: "select" }>,
  raw: string | null | undefined,
): string | undefined {
  const trimmed = trimOrNull(raw);
  if (!trimmed) {
    return descriptor.currentValue ?? descriptor.options.find((option) => option.isDefault)?.id;
  }
  if (descriptor.options.length === 0) {
    return trimmed;
  }
  if (
    descriptor.promptInjectedValues?.includes(trimmed) &&
    descriptor.options.some((option) => option.id === trimmed)
  ) {
    return descriptor.options.find((option) => option.isDefault)?.id;
  }
  if (descriptor.options.some((option) => option.id === trimmed)) {
    return trimmed;
  }
  return descriptor.currentValue ?? descriptor.options.find((option) => option.isDefault)?.id;
}

function cloneDescriptor(descriptor: ProviderOptionDescriptor): ProviderOptionDescriptor {
  return descriptor.type === "select"
    ? {
        ...descriptor,
        options: [...descriptor.options],
        ...(descriptor.promptInjectedValues
          ? { promptInjectedValues: [...descriptor.promptInjectedValues] }
          : {}),
      }
    : { ...descriptor };
}

function cloneSelection(selection: ProviderOptionSelection): ProviderOptionSelection {
  return { ...selection };
}

function visibleSelections(
  selections: ReadonlyArray<ProviderOptionSelection> | null | undefined,
): ReadonlyArray<ProviderOptionSelection> {
  return selections?.filter((selection) => selection.id !== PROVIDER_VARIANT_SELECTION_ID) ?? [];
}

/**
 * Score a variant against the current selections: more matching values wins,
 * then variants whose values are catalog-declared `isDefault` choices, then
 * catalog order (callers iterate variants in order and keep the first max).
 */
function scoreVariant(
  variant: ProviderOptionVariant,
  current: ReadonlyMap<string, string | boolean>,
  descriptorById: ReadonlyMap<string, ProviderOptionDescriptor>,
): { matches: number; defaults: number } {
  const variantValues = new Map(variant.selections.map((s) => [s.id, s.value]));
  let matches = 0;
  for (const [id, value] of current) {
    if (variantValues.get(id) === value) matches++;
  }
  let defaults = 0;
  for (const selection of variant.selections) {
    const descriptor = descriptorById.get(selection.id);
    if (
      descriptor?.type === "select" &&
      descriptor.options.some((option) => option.id === selection.value && option.isDefault)
    ) {
      defaults++;
    }
  }
  return { matches, defaults };
}

/**
 * Resolve the catalog variant that best matches the current visible
 * selections. Deterministic: maximize matches, prefer catalog-declared
 * defaults, then keep catalog order. When `pinnedIds` is set (e.g. the option
 * the user just changed), only variants satisfying every pinned value are
 * eligible — the explicit choice is never overridden.
 */
export function resolveProviderOptionVariant(input: {
  caps: ModelCapabilities;
  selections: ReadonlyArray<ProviderOptionSelection> | null | undefined;
  pinnedIds?: ReadonlyArray<string> | undefined;
}): ProviderOptionVariant | undefined {
  const variants = input.caps.optionVariants;
  if (!variants || variants.length === 0) return undefined;

  const current = new Map<string, string | boolean>();
  for (const selection of visibleSelections(input.selections)) {
    current.set(selection.id, selection.value);
  }
  const descriptorById = new Map(
    (input.caps.optionDescriptors ?? []).map((descriptor) => [descriptor.id, descriptor]),
  );

  let candidates = variants;
  const pinned = input.pinnedIds;
  if (pinned && pinned.length > 0) {
    const satisfying = variants.filter((variant) =>
      pinned.every((id) => {
        const wanted = current.get(id);
        if (wanted === undefined) return true;
        return variant.selections.some((s) => s.id === id && s.value === wanted);
      }),
    );
    if (satisfying.length > 0) candidates = satisfying;
  }

  // A stored `__providerVariant` that is still in the catalog wins outright:
  // it preserves the exact pairing the user last dispatched instead of
  // re-deriving a possibly different variant from the same visible picks.
  const hintedUid = input.selections?.find(
    (selection) => selection.id === PROVIDER_VARIANT_SELECTION_ID,
  )?.value;
  if (typeof hintedUid === "string") {
    const hint = candidates.find((variant) => variant.model === hintedUid);
    if (hint) return hint;
  }

  let best: ProviderOptionVariant | undefined;
  let bestScore = { matches: -1, defaults: -1 };
  for (const variant of candidates) {
    const score = scoreVariant(variant, current, descriptorById);
    if (
      score.matches > bestScore.matches ||
      (score.matches === bestScore.matches && score.defaults > bestScore.defaults)
    ) {
      best = variant;
      bestScore = score;
    }
  }
  return best;
}

/**
 * Normalize stored/requested selections against the variant table. Returns
 * the resolved variant's visible selections plus the reserved
 * `__providerVariant` entry carrying the exact provider model UID. When the
 * model has no variant table the selections pass through unchanged.
 */
export function normalizeProviderOptionSelections(input: {
  caps: ModelCapabilities;
  selections: ReadonlyArray<ProviderOptionSelection> | null | undefined;
  pinnedIds?: ReadonlyArray<string> | undefined;
}): ReadonlyArray<ProviderOptionSelection> | undefined {
  const variant = resolveProviderOptionVariant(input);
  if (!variant) return input.selections ?? undefined;
  return [
    ...variant.selections.map(cloneSelection),
    { id: PROVIDER_VARIANT_SELECTION_ID, value: variant.model },
  ];
}

/**
 * Values still reachable for `descriptorId` given the other current
 * selections: the union of that option's values across variants matching the
 * rest of the current state. Returns undefined without a variant table.
 */
export function getCompatibleProviderOptionValues(input: {
  caps: ModelCapabilities;
  selections: ReadonlyArray<ProviderOptionSelection> | null | undefined;
  descriptorId: string;
}): ReadonlySet<string | boolean> | undefined {
  const variants = input.caps.optionVariants;
  if (!variants || variants.length === 0) return undefined;
  const current = new Map<string, string | boolean>();
  for (const selection of visibleSelections(input.selections)) {
    if (selection.id !== input.descriptorId) current.set(selection.id, selection.value);
  }
  const compatible = new Set<string | boolean>();
  for (const variant of variants) {
    const variantValues = new Map(variant.selections.map((s) => [s.id, s.value]));
    if (!variantValues.has(input.descriptorId)) continue;
    let consistent = true;
    for (const [id, value] of current) {
      if (variantValues.get(id) !== value) {
        consistent = false;
        break;
      }
    }
    if (consistent) compatible.add(variantValues.get(input.descriptorId)!);
  }
  return compatible;
}

function withDescriptorCurrentValue(
  descriptor: ProviderOptionDescriptor,
  rawCurrentValue: string | boolean | undefined,
): ProviderOptionDescriptor {
  if (descriptor.type === "boolean") {
    if (typeof rawCurrentValue === "boolean") {
      return {
        ...descriptor,
        currentValue: rawCurrentValue,
      };
    }
    return descriptor;
  }
  const currentValue =
    typeof rawCurrentValue === "string"
      ? resolveDescriptorChoiceValue(descriptor, rawCurrentValue)
      : resolveDescriptorChoiceValue(descriptor, descriptor.currentValue);
  if (!currentValue) {
    const { currentValue: _unusedCurrentValue, ...rest } = descriptor;
    return rest;
  }
  return {
    ...descriptor,
    currentValue,
  };
}

export function getProviderOptionDescriptors(input: {
  caps: ModelCapabilities;
  selections?: ReadonlyArray<ProviderOptionSelection> | null | undefined;
}): ReadonlyArray<ProviderOptionDescriptor> {
  const { caps } = input;
  // Models with a variant table resolve their visible state through the best
  // matching variant first, so stale or partial selections normalize to a
  // valid combination before descriptors are built.
  const selections =
    normalizeProviderOptionSelections({ caps, selections: input.selections }) ?? input.selections;
  const baseDescriptors = (caps.optionDescriptors ?? []).map(cloneDescriptor);

  return baseDescriptors.map((descriptor) => {
    const withValue = withDescriptorCurrentValue(
      descriptor,
      getRawSelectionValueById(selections, descriptor.id) ?? descriptor.currentValue,
    );
    // Filter each select's choices to values that can still produce a valid
    // variant given the rest of the current selection. A descriptor reduced
    // to a single choice is this state's pivot control — narrowing it would
    // deadlock sparse catalogs, so it keeps every advertised choice.
    if (withValue.type !== "select" || !caps.optionVariants?.length) {
      return withValue;
    }
    const compatible = getCompatibleProviderOptionValues({
      caps,
      selections,
      descriptorId: descriptor.id,
    });
    if (!compatible || compatible.size <= 1) return withValue;
    return {
      ...withValue,
      options: withValue.options.filter((option) => compatible.has(option.id)),
    };
  });
}

export function getProviderOptionCurrentValue(
  descriptor: ProviderOptionDescriptor | null | undefined,
): string | boolean | undefined {
  if (!descriptor) {
    return undefined;
  }
  if (descriptor.type === "boolean") {
    return descriptor.currentValue;
  }
  if (descriptor.currentValue) {
    return descriptor.currentValue;
  }
  return descriptor.options.find((option) => option.isDefault)?.id;
}

export function getProviderOptionCurrentLabel(
  descriptor: ProviderOptionDescriptor | null | undefined,
): string | undefined {
  if (!descriptor) {
    return undefined;
  }
  if (descriptor.type === "boolean") {
    return typeof descriptor.currentValue === "boolean"
      ? descriptor.currentValue
        ? "On"
        : "Off"
      : undefined;
  }
  const currentValue = getProviderOptionCurrentValue(descriptor);
  if (typeof currentValue !== "string") {
    return undefined;
  }
  return descriptor.options.find((option) => option.id === currentValue)?.label;
}

export function buildProviderOptionSelectionsFromDescriptors(
  descriptors: ReadonlyArray<ProviderOptionDescriptor> | null | undefined,
  options?: {
    readonly caps?: ModelCapabilities | null | undefined;
    /** Option ids whose values must survive normalization (e.g. the control
     * the user just changed). Other fields may shift to a valid pairing. */
    readonly pinnedIds?: ReadonlyArray<string> | undefined;
  },
): Array<ProviderOptionSelection> | undefined {
  if (!descriptors || descriptors.length === 0) {
    return undefined;
  }

  const nextSelections: Array<ProviderOptionSelection> = [];

  for (const descriptor of descriptors) {
    const value = getProviderOptionCurrentValue(descriptor);
    if (typeof value === "string" || typeof value === "boolean") {
      nextSelections.push({ id: descriptor.id, value });
    }
  }

  const caps = options?.caps;
  if (caps?.optionVariants?.length) {
    return [
      ...(normalizeProviderOptionSelections({
        caps,
        selections: nextSelections,
        ...(options?.pinnedIds ? { pinnedIds: options.pinnedIds } : {}),
      }) ?? []),
    ];
  }

  return nextSelections.length > 0 ? nextSelections : undefined;
}

export function buildExplicitProviderOptionSelectionsFromDescriptors(
  descriptors: ReadonlyArray<ProviderOptionDescriptor> | null | undefined,
  selections: ReadonlyArray<ProviderOptionSelection> | null | undefined,
  caps?: ModelCapabilities | null | undefined,
): Array<ProviderOptionSelection> | undefined {
  const hasVariants = (caps?.optionVariants?.length ?? 0) > 0;
  if ((!selections || selections.length === 0) && !hasVariants) {
    return undefined;
  }
  const explicitIds = new Set(
    (selections ?? [])
      .map((selection) => selection.id)
      .filter((id) => id !== PROVIDER_VARIANT_SELECTION_ID),
  );
  const normalized = buildProviderOptionSelectionsFromDescriptors(descriptors)?.filter(
    (selection) => explicitIds.has(selection.id),
  );
  if (hasVariants) {
    // Variant models dispatch an exact UID, so the resolved variant's full
    // selection set is emitted even when the user never opened the picker.
    const carriedVariant = (selections ?? []).find(
      (selection) => selection.id === PROVIDER_VARIANT_SELECTION_ID,
    );
    return [
      ...(normalizeProviderOptionSelections({
        caps: caps!,
        selections: [...(normalized ?? []), ...(carriedVariant ? [carriedVariant] : [])],
        // The user's explicit picks pin the resolution: a stale carried
        // variant that contradicts them loses instead of silently winning.
        pinnedIds: [...explicitIds],
      }) ?? []),
    ];
  }
  return normalized && normalized.length > 0 ? normalized : undefined;
}

export function isClaudeUltrathinkPrompt(text: string | null | undefined): boolean {
  return typeof text === "string" && /\bultrathink\b/i.test(text);
}

/** Compare Codex model families without changing provider-owned dispatch identifiers. */
export function codexModelFamily(slug: string): string {
  return slug.startsWith("openai.gpt-") ? slug.slice("openai.".length) : slug;
}

export function normalizeModelSlug(
  model: string | null | undefined,
  provider: ProviderDriverKind = DEFAULT_PROVIDER_DRIVER_KIND,
): string | null {
  const trimmed = normalizeCustomModelSlug(model);
  if (!trimmed) {
    return null;
  }

  const aliases = MODEL_SLUG_ALIASES_BY_PROVIDER[provider] ?? {};
  const aliased = Object.prototype.hasOwnProperty.call(aliases, trimmed)
    ? aliases[trimmed]
    : undefined;
  return typeof aliased === "string" ? aliased : trimmed;
}

/** Custom model identifiers are provider-owned, so only trim them; never expand aliases. */
export function normalizeCustomModelSlug(model: string | null | undefined): string | null {
  if (typeof model !== "string") {
    return null;
  }

  return model.trim() || null;
}

/** A custom model setting with its optional fields resolved. */
export interface CustomModelDefinition {
  readonly slug: string;
  readonly name: string;
  readonly capabilities: ModelCapabilities | null;
}

const decodeCustomModelCapabilities = Schema.decodeUnknownOption(ModelCapabilities);

/**
 * Read a `customModels` setting into resolved definitions. Accepts the typed
 * union as well as the opaque `providerInstances[id].config` blob clients see,
 * so it tolerates bare slugs, malformed rows, and unparseable capabilities
 * (dropped rather than failing the whole list). Slugs are trimmed and
 * deduplicated, first occurrence wins; `name` falls back to the slug.
 */
export function readCustomModelEntries(value: unknown): CustomModelDefinition[] {
  if (!Array.isArray(value)) return [];
  const entries: CustomModelDefinition[] = [];
  const seen = new Set<string>();
  for (const raw of value) {
    const record =
      typeof raw === "string"
        ? { slug: raw }
        : raw !== null && typeof raw === "object"
          ? (raw as { slug?: unknown; name?: unknown; capabilities?: unknown })
          : null;
    if (!record) continue;
    const slug = normalizeCustomModelSlug(typeof record.slug === "string" ? record.slug : null);
    if (!slug || seen.has(slug)) continue;
    seen.add(slug);
    const name =
      (typeof record.name === "string" ? normalizeCustomModelSlug(record.name) : null) ?? slug;
    const capabilities =
      record.capabilities === undefined || record.capabilities === null
        ? null
        : Option.getOrNull(decodeCustomModelCapabilities(record.capabilities));
    entries.push({
      slug,
      name,
      capabilities: capabilities
        ? createModelCapabilities({ optionDescriptors: capabilities.optionDescriptors ?? [] })
        : null,
    });
  }
  return entries;
}

/**
 * Write a definition back to the compact stored shape: a bare slug when it
 * carries nothing custom, otherwise an entry with only the set fields.
 */
export function toCustomModelSetting(entry: CustomModelDefinition): CustomModelSetting {
  const descriptors = entry.capabilities?.optionDescriptors ?? [];
  const name = entry.name !== entry.slug ? entry.name : undefined;
  if (!name && descriptors.length === 0) return entry.slug;
  return {
    slug: entry.slug,
    ...(name ? { name } : {}),
    ...(descriptors.length > 0
      ? { capabilities: createModelCapabilities({ optionDescriptors: descriptors }) }
      : {}),
  };
}

export function resolveSelectableModel(
  provider: ProviderDriverKind,
  value: string | null | undefined,
  options: ReadonlyArray<SelectableModelOption>,
): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  const direct = options.find((option) => option.slug === trimmed);
  if (direct) {
    return direct.slug;
  }

  const byName = options.find((option) => option.name.toLowerCase() === trimmed.toLowerCase());
  if (byName) {
    return byName.slug;
  }

  const byAlias = options.find((option) =>
    option.aliases?.some((alias) => alias.toLowerCase() === trimmed.toLowerCase()),
  );
  if (byAlias) {
    return byAlias.slug;
  }

  const normalized = normalizeModelSlug(trimmed, provider);
  if (!normalized) {
    return null;
  }

  const resolved = options.find((option) => option.slug === normalized);
  return resolved ? resolved.slug : null;
}

/** Trim a string, returning null for empty/missing values. */
function trimOrNull<T extends string>(value: T | null | undefined): T | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim() as T;
  return trimmed || null;
}

function cloneSelections(
  selections: ReadonlyArray<ProviderOptionSelection>,
): Array<ProviderOptionSelection> {
  return selections.map(cloneSelection);
}

export function createModelSelection(
  instanceId: ProviderInstanceId,
  model: string,
  options?: ReadonlyArray<ProviderOptionSelection> | null,
): ModelSelection {
  const selections = options ? cloneSelections(options) : [];
  const base: ModelSelection = {
    instanceId,
    model,
  };
  return selections.length > 0 ? { ...base, options: selections } : base;
}

/**
 * Returns the effort value if it is a prompt-injected value according to
 * any select descriptor in the given capabilities, or null otherwise.
 *
 * Unlike a single `find`, this checks every descriptor so that the
 * correct descriptor's `promptInjectedValues` list is consulted even when
 * multiple select descriptors exist.
 */
export function resolvePromptInjectedEffort(
  caps: ModelCapabilities,
  rawEffort: string | null | undefined,
): string | null {
  const trimmed = trimOrNull(rawEffort);
  if (!trimmed) return null;
  const descriptors = getProviderOptionDescriptors({ caps });
  for (const descriptor of descriptors) {
    if (descriptor.type === "select" && descriptor.promptInjectedValues?.includes(trimmed)) {
      return trimmed;
    }
  }
  return null;
}

export function applyClaudePromptEffortPrefix(
  text: string,
  effort: string | null | undefined,
): string {
  const trimmed = text.trim();
  if (!trimmed) {
    return trimmed;
  }
  // Prefixing a slash command turns it into plain prose, so Claude never
  // runs it. Command names come from arbitrary file names ("/deploy.prod",
  // "/plugin:skill"), so accept any first token without a second slash;
  // absolute paths like "/home/theo/app.ts" keep the prefix.
  if (effort !== "ultrathink" || /^\/[^\s/]+(?:\s|$)/u.test(trimmed)) {
    return trimmed;
  }
  if (trimmed.startsWith("Ultrathink:")) {
    return trimmed;
  }
  return `Ultrathink:\n${trimmed}`;
}
