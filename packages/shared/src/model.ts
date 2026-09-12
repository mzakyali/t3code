import {
  type CustomModelSetting,
  MODEL_SLUG_ALIASES_BY_PROVIDER,
  ModelCapabilities,
  type ModelSelection,
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
      ? { optionVariants: input.optionVariants.map(cloneVariant) }
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

function cloneVariant(variant: ProviderOptionVariant): ProviderOptionVariant {
  return { ...variant, selections: variant.selections.map(cloneSelection) };
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

/**
 * Reserved selection id that carries the exact provider model UID of the
 * currently selected option variant. It rides along inside
 * `ModelSelection.options` so the server can route without reconstructing a
 * UID from labels, but it is never exposed as a user-facing descriptor.
 */
export const PROVIDER_OPTION_VARIANT_SELECTION_ID = "__providerVariant";

/**
 * Chooses the catalog variant that best preserves the supplied visible
 * selections. A stored `__providerVariant` wins only when every visible
 * selection still matches that row. Otherwise supplied values that diverge
 * from the stored row pin the choice — that divergence is the newly changed
 * control — falling back to divergence from the catalog-declared defaults
 * when no stored row exists. A pin only counts when at least one variant
 * supports the value, so a deliberate change beats incidental matches. Ties
 * break on total matches with previous selections, then on how many
 * catalog-declared defaults a variant keeps, then catalog order.
 */
function resolveProviderOptionVariant(input: {
  readonly caps: ModelCapabilities | null | undefined;
  readonly selections: ReadonlyArray<ProviderOptionSelection> | null | undefined;
}): ProviderOptionVariant | undefined {
  const variants = input.caps?.optionVariants ?? [];
  if (variants.length === 0) {
    return undefined;
  }

  const descriptors = input.caps?.optionDescriptors ?? [];
  const descriptorIds = new Set(descriptors.map((descriptor) => descriptor.id));
  const current = new Map(
    (input.selections ?? [])
      .filter((selection) => descriptorIds.has(selection.id))
      .map((selection) => [selection.id, selection.value] as const),
  );
  const internal = input.selections?.find(
    (selection) => selection.id === PROVIDER_OPTION_VARIANT_SELECTION_ID,
  )?.value;
  const stored =
    typeof internal === "string"
      ? variants.find((variant) => variant.model === internal)
      : undefined;
  if (
    stored &&
    stored.selections.every((selection) => current.get(selection.id) === selection.value)
  ) {
    return stored;
  }

  const catalogDefaults = new Map(
    descriptors.flatMap((descriptor) => {
      const value =
        descriptor.type === "select"
          ? (descriptor.currentValue ?? descriptor.options.find((option) => option.isDefault)?.id)
          : descriptor.currentValue;
      return value === undefined ? [] : [[descriptor.id, value] as const];
    }),
  );
  const reference = stored
    ? new Map(stored.selections.map((selection) => [selection.id, selection.value] as const))
    : catalogDefaults;
  const pinned = [...current.entries()].filter(
    ([id, value]) =>
      reference.get(id) !== value &&
      variants.some((variant) =>
        variant.selections.some((selection) => selection.id === id && selection.value === value),
      ),
  );

  return variants
    .map((variant, index) => {
      const row = new Map(
        variant.selections.map((selection) => [selection.id, selection.value] as const),
      );
      return {
        variant,
        index,
        pins: pinned.reduce((count, [id, value]) => count + (row.get(id) === value ? 1 : 0), 0),
        matches: variant.selections.reduce(
          (count, selection) => count + (current.get(selection.id) === selection.value ? 1 : 0),
          0,
        ),
        defaults: variant.selections.reduce(
          (count, selection) =>
            count + (catalogDefaults.get(selection.id) === selection.value ? 1 : 0),
          0,
        ),
      };
    })
    .sort(
      (left, right) =>
        right.pins - left.pins ||
        right.matches - left.matches ||
        right.defaults - left.defaults ||
        left.index - right.index,
    )[0]?.variant;
}

export function getProviderOptionDescriptors(input: {
  caps: ModelCapabilities;
  selections?: ReadonlyArray<ProviderOptionSelection> | null | undefined;
}): ReadonlyArray<ProviderOptionDescriptor> {
  const { caps, selections } = input;
  const baseDescriptors = (caps.optionDescriptors ?? [])
    .filter((descriptor) => descriptor.id !== PROVIDER_OPTION_VARIANT_SELECTION_ID)
    .map(cloneDescriptor);
  const variants = caps.optionVariants ?? [];

  if (variants.length === 0) {
    return baseDescriptors.map((descriptor) =>
      withDescriptorCurrentValue(
        descriptor,
        getRawSelectionValueById(selections, descriptor.id) ?? descriptor.currentValue,
      ),
    );
  }

  const selected = resolveProviderOptionVariant({ caps, selections });
  const selectedValues = new Map(
    (selected?.selections ?? []).map((selection) => [selection.id, selection.value] as const),
  );
  const variantRows = variants.map(
    (variant) =>
      new Map(variant.selections.map((selection) => [selection.id, selection.value] as const)),
  );

  return baseDescriptors.map((descriptor) => {
    const selectedValue = selectedValues.get(descriptor.id);
    if (descriptor.type === "boolean") {
      return withDescriptorCurrentValue(
        descriptor,
        typeof selectedValue === "boolean" ? selectedValue : descriptor.currentValue,
      );
    }
    // A choice stays visible only while at least one variant can pair it with
    // the other currently selected values.
    const compatible = new Set(
      variantRows
        .filter((row) =>
          [...selectedValues.entries()].every(
            ([id, value]) => id === descriptor.id || row.get(id) === value,
          ),
        )
        .map((row) => row.get(descriptor.id)),
    );
    const options = descriptor.options.filter((option) => compatible.has(option.id));
    return withDescriptorCurrentValue(
      options.length === descriptor.options.length ? descriptor : { ...descriptor, options },
      typeof selectedValue === "string" ? selectedValue : descriptor.currentValue,
    );
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

  return nextSelections.length > 0 ? nextSelections : undefined;
}

export function buildExplicitProviderOptionSelectionsFromDescriptors(
  descriptors: ReadonlyArray<ProviderOptionDescriptor> | null | undefined,
  selections: ReadonlyArray<ProviderOptionSelection> | null | undefined,
): Array<ProviderOptionSelection> | undefined {
  if (!selections || selections.length === 0) {
    return undefined;
  }
  const explicitIds = new Set(selections.map((selection) => selection.id));
  const normalized = buildProviderOptionSelectionsFromDescriptors(descriptors)?.filter(
    (selection) => explicitIds.has(selection.id),
  );
  return normalized && normalized.length > 0 ? normalized : undefined;
}

/**
 * Normalizes stored or edited option selections against the capability's
 * variant table. Without variants the selections are returned cloned and
 * untouched. With variants, the visible selections are replaced by the best
 * valid variant row (see `resolveProviderOptionVariant`), the exact variant
 * UID is refreshed under `__providerVariant`, and selections whose ids are
 * neither descriptors nor the reserved id pass through unchanged so other
 * provider options are not lost.
 */
export function normalizeProviderOptionSelections(input: {
  readonly caps: ModelCapabilities | null | undefined;
  readonly selections: ReadonlyArray<ProviderOptionSelection> | null | undefined;
}): Array<ProviderOptionSelection> | undefined {
  const variants = input.caps?.optionVariants ?? [];
  if (variants.length === 0) {
    return input.selections?.map(cloneSelection);
  }

  const descriptorIds = new Set(
    (input.caps?.optionDescriptors ?? []).map((descriptor) => descriptor.id),
  );
  const selected = resolveProviderOptionVariant(input);
  if (!selected) {
    return input.selections?.map(cloneSelection);
  }

  const unrelated = (input.selections ?? []).filter(
    (selection) =>
      !descriptorIds.has(selection.id) && selection.id !== PROVIDER_OPTION_VARIANT_SELECTION_ID,
  );
  return [
    ...unrelated.map(cloneSelection),
    ...selected.selections.map(cloneSelection),
    { id: PROVIDER_OPTION_VARIANT_SELECTION_ID, value: selected.model },
  ];
}

/**
 * Serializes edited descriptors into wire selections normalized against the
 * variant table, so a change to one constrained option snaps the dependent
 * values to a valid variant and retains its exact model UID. When
 * `explicitSelections` is given, only those ids are emitted — plus the
 * reserved variant id, which must survive dispatch even though no descriptor
 * produces it.
 */
export function buildProviderOptionSelectionsForModel(input: {
  readonly caps: ModelCapabilities | null | undefined;
  readonly descriptors: ReadonlyArray<ProviderOptionDescriptor> | null | undefined;
  readonly explicitSelections?: ReadonlyArray<ProviderOptionSelection> | null | undefined;
}): Array<ProviderOptionSelection> | undefined {
  const allSelections = buildProviderOptionSelectionsFromDescriptors(input.descriptors);
  const normalized = normalizeProviderOptionSelections({
    caps: input.caps,
    selections: allSelections,
  });
  if (!input.explicitSelections || !normalized) return normalized;
  const explicitIds = new Set(input.explicitSelections.map((selection) => selection.id));
  return normalized.filter(
    (selection) =>
      explicitIds.has(selection.id) || selection.id === PROVIDER_OPTION_VARIANT_SELECTION_ID,
  );
}

export function isClaudeUltrathinkPrompt(text: string | null | undefined): boolean {
  return typeof text === "string" && /\bultrathink\b/i.test(text);
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
        ? createModelCapabilities({
            optionDescriptors: capabilities.optionDescriptors ?? [],
            optionVariants: capabilities.optionVariants ?? [],
          })
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
  const variants = entry.capabilities?.optionVariants ?? [];
  const name = entry.name !== entry.slug ? entry.name : undefined;
  if (!name && descriptors.length === 0 && variants.length === 0) return entry.slug;
  return {
    slug: entry.slug,
    ...(name ? { name } : {}),
    ...(descriptors.length > 0 || variants.length > 0
      ? {
          capabilities: createModelCapabilities({
            optionDescriptors: descriptors,
            optionVariants: variants,
          }),
        }
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
