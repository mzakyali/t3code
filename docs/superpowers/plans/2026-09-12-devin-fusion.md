# Devin Fusion cross-surface model controls Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `subagent-driven-development` (recommended) to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add catalog-driven Devin Fusion controls to T3 while preserving the exact selected Fusion model UID across web, desktop, mobile, and remote connections.

**Architecture:** The Devin server adapter will publish one stable `fusion` model with visible option descriptors and an optional table of valid concrete variants. Shared model helpers will normalize dependent choices and retain the exact variant as an internal option selection; web, desktop, mobile, and remote clients will consume that contract without parsing Devin UIDs.

**Tech Stack:** TypeScript, Effect Schema, Effect ACP, Vite Plus/Vitest, React, React Native, existing T3 WebSocket/server contracts.

## Global Constraints

- Keep Fusion-specific parsing and UID resolution at the Devin provider boundary; clients must not parse Devin model UIDs.
- Use the installed Devin catalog as the source of truth; do not hardcode a Fusion model list or variant count.
- Emit one stable `fusion` model row and preserve each concrete `model_uid` through the internal `__providerVariant` selection.
- Only publish valid catalog pairings; changing one visible option may update dependent values deterministically.
- Keep `optionVariants` optional so providers, custom models, old persisted selections, and older clients without variants remain readable.
- Preserve all existing generic Devin reasoning, speed, context-window, opaque UID, pricing, and ACP behavior.
- Desktop inherits the web implementation; no second desktop-only Fusion state is allowed.
- Remote, relay, and tunnel clients receive the same `ServerProviderModel` capability data and never need Devin credentials or a local Devin binary.
- Use focused tests and typechecks only; do not run repo-wide checks such as `vp check`, `vp run -r test`, or `vp run -r typecheck`.
- Do not use browser, simulator, or computer control during implementation unless the user explicitly authorizes it; live Devin tests must use isolated state rather than the shared T3 home.
- Do not stage or modify the existing untracked user files: `devin-fork-handoff.md`, `devin-upstream-port-conversation.md`, or unrelated files under `docs/superpowers/`.

---

## File map

- `packages/contracts/src/model.ts` — add the optional provider option-variant schema used on the wire.
- `packages/contracts/src/model.test.ts` — verify variant capability decoding and malformed variant rejection.
- `packages/shared/src/model.ts` — clone, resolve, filter, and serialize constrained provider options.
- `packages/shared/src/model.test.ts` — test valid combinations, defaults, stale selections, and unchanged independent options.
- `apps/server/src/provider/Layers/DevinProvider.ts` — parse the Devin Fusion family separately and publish its capabilities.
- `apps/server/src/provider/Layers/DevinProvider.test.ts` — cover current Fusion UID shapes and the single grouped model row.
- `apps/server/src/provider/acp/DevinAcpSupport.ts` — resolve the internal exact Fusion UID and map concrete UIDs to the stable family base.
- `apps/server/src/provider/acp/DevinAcpSupport.test.ts` — test Fusion resolution alongside existing Devin model resolution.
- `apps/server/src/provider/Layers/DevinAdapter.ts` and `apps/server/src/provider/Layers/DevinAdapter.test.ts` — retain the active Fusion UID during in-session configuration and cover adapter-level dispatch.
- `apps/web/src/components/chat/TraitsPicker.tsx` — use shared variant-aware option serialization in the existing web traits picker.
- `apps/web/src/components/chat/TraitsPicker.test.ts` — verify Fusion labels do not expose internal routing metadata.
- `apps/web/src/components/chat/composerProviderState.tsx` and `.test.tsx` — preserve the exact Fusion selection in turn dispatch while retaining explicit-option semantics.
- `apps/web/src/components/chat/modelFamilyGrouping.ts` and `.test.ts` — treat Fusion effort as the reasoning control and normalize changes through the shared resolver.
- `apps/mobile/src/lib/providerOptions.ts` and `.test.ts` — apply constrained option changes through the shared resolver.
- `apps/mobile/src/lib/modelOptions.ts` and `.test.ts` — retain the internal variant when building mobile model options.
- `apps/mobile/src/features/threads/ThreadSettingsSheet.tsx` — pass capabilities through existing-thread and new-task settings flows.
- `apps/mobile/src/features/threads/ThreadComposer.tsx` — supply the current model capabilities to the settings sheet.
- `docs/user/providers-devin.md` — document selecting Fusion and its provider-driven controls.

No new desktop source file is required. Existing server configuration serialization already carries `ServerProviderModel.capabilities`; the contract tests will prove the remote path.

## Task 1: Add constrained model variants to the shared contract

**Files:**

- Modify: `packages/contracts/src/model.ts`
- Create: `packages/contracts/src/model.test.ts`

**Interfaces:**

- Produces `ProviderOptionVariant` with `model: TrimmedNonEmptyString` and `selections: Array<ProviderOptionSelection>`.
- Extends `ModelCapabilities` with optional `optionVariants: Array<ProviderOptionVariant>`.
- Leaves `ProviderOptionDescriptor`, `ProviderOptionSelection`, and all existing provider capability fields backward-compatible.

- [ ] **Step 1: Write the failing schema tests**

Add a valid Fusion capability fixture and assert that Effect Schema keeps the exact concrete UID and visible selections:

```ts
import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";
import { ModelCapabilities } from "./model";

const decodeCapabilities = Schema.decodeUnknownSync(ModelCapabilities);

it("decodes provider option variants without changing ordinary descriptors", () => {
  const result = decodeCapabilities({
    optionDescriptors: [
      {
        id: "fusionLead",
        label: "Lead",
        type: "select",
        options: [{ id: "lead-a", label: "Lead A", isDefault: true }],
      },
    ],
    optionVariants: [
      {
        model: "fusion-lead-a-medium-sidekick-swe-2-medium",
        selections: [
          { id: "fusionLead", value: "lead-a" },
          { id: "fusionEffort", value: "medium" },
          { id: "fusionSidekick", value: "swe-2-medium" },
          { id: "fastMode", value: false },
        ],
      },
    ],
  });

  expect(result.optionVariants).toEqual([
    expect.objectContaining({
      model: "fusion-lead-a-medium-sidekick-swe-2-medium",
    }),
  ]);
});

it("rejects an option variant with an empty concrete model id", () => {
  expect(() =>
    decodeCapabilities({
      optionVariants: [{ model: "   ", selections: [] }],
    }),
  ).toThrow();
});
```

- [ ] **Step 2: Run the contract tests to verify they fail**

Run:

```bash
vp test run packages/contracts/src/model.test.ts
```

Expected: FAIL because `ModelCapabilities` does not yet decode `optionVariants` and `packages/contracts/src/model.test.ts` is new.

- [ ] **Step 3: Add the minimal schema types**

Declare the new schema after `ProviderOptionSelection` so the selection type is available, then add the optional field to `ModelCapabilities`:

```ts
export const ProviderOptionVariant = Schema.Struct({
  model: TrimmedNonEmptyString,
  selections: Schema.Array(ProviderOptionSelection),
});
export type ProviderOptionVariant = typeof ProviderOptionVariant.Type;

export const ModelCapabilities = Schema.Struct({
  optionDescriptors: Schema.optional(Schema.Array(ProviderOptionDescriptor)),
  optionVariants: Schema.optional(Schema.Array(ProviderOptionVariant)),
  inputImages: Schema.optional(Schema.Boolean),
  inputAudio: Schema.optional(Schema.Boolean),
  inputFiles: Schema.optional(Schema.Boolean),
});
```

Keep the new field optional and do not add a refinement that assumes a unique variant or a fixed Fusion shape; provider parsers will perform those semantic checks.

- [ ] **Step 4: Run the focused contract tests**

Run:

```bash
vp test run packages/contracts/src/model.test.ts
vp test run packages/contracts/src/orchestration.test.ts -t "ModelSelection"
vp run --filter @t3tools/contracts typecheck
```

Expected: PASS, with the pre-existing `ModelSelection` array/legacy compatibility tests unchanged.

- [ ] **Step 5: Commit the contract change**

```bash
git add packages/contracts/src/model.ts packages/contracts/src/model.test.ts
git commit -m "feat(contracts): support constrained model variants"
```

## Task 2: Implement shared variant normalization and selection retention

**Files:**

- Modify: `packages/shared/src/model.ts`
- Modify: `packages/shared/src/model.test.ts`

**Interfaces:**

- Produces `PROVIDER_OPTION_VARIANT_SELECTION_ID = "__providerVariant"`.
- Produces `normalizeProviderOptionSelections(input: { caps: ModelCapabilities | null | undefined; selections: ReadonlyArray<ProviderOptionSelection> | null | undefined }): Array<ProviderOptionSelection> | undefined`.
- Produces `buildProviderOptionSelectionsForModel(input: { caps: ModelCapabilities | null | undefined; descriptors: ReadonlyArray<ProviderOptionDescriptor> | null | undefined; explicitSelections?: ReadonlyArray<ProviderOptionSelection> | null | undefined }): Array<ProviderOptionSelection> | undefined`.
- Updates `getProviderOptionDescriptors` so variant-backed descriptors expose compatible choices and current values derived from a valid variant.

- [ ] **Step 1: Write failing shared-helper tests**

Add a compact fixture with two valid pairings that share the lead but use different sidekicks:

```ts
const fusionCaps = createModelCapabilities({
  optionDescriptors: [
    {
      id: "fusionLead",
      label: "Lead",
      type: "select",
      options: [
        { id: "lead-a", label: "Lead A", isDefault: true },
        { id: "lead-b", label: "Lead B" },
      ],
    },
    {
      id: "fusionEffort",
      label: "Effort",
      type: "select",
      options: [
        { id: "medium", label: "Medium", isDefault: true },
        { id: "high", label: "High" },
      ],
    },
    {
      id: "fusionSidekick",
      label: "Sidekick",
      type: "select",
      options: [
        { id: "swe-2-medium", label: "SWE-2 Medium", isDefault: true },
        { id: "glm-5-2", label: "GLM-5.2" },
      ],
    },
    { id: "fastMode", label: "Fast Mode", type: "boolean", currentValue: false },
  ],
  optionVariants: [
    {
      model: "fusion-lead-a-medium-sidekick-swe-2-medium",
      selections: [
        { id: "fusionLead", value: "lead-a" },
        { id: "fusionEffort", value: "medium" },
        { id: "fusionSidekick", value: "swe-2-medium" },
        { id: "fastMode", value: false },
      ],
    },
    {
      model: "fusion-lead-b-high-fast-sidekick-glm-5-2",
      selections: [
        { id: "fusionLead", value: "lead-b" },
        { id: "fusionEffort", value: "high" },
        { id: "fusionSidekick", value: "glm-5-2" },
        { id: "fastMode", value: true },
      ],
    },
  ],
});

it("filters choices and retains the exact selected variant", () => {
  const descriptors = getProviderOptionDescriptors({ caps: fusionCaps });
  const next = descriptors.map((descriptor) =>
    descriptor.id === "fusionLead" ? { ...descriptor, currentValue: "lead-b" } : descriptor,
  );
  const selections = buildProviderOptionSelectionsForModel({
    caps: fusionCaps,
    descriptors: next,
  });

  expect(selections).toEqual([
    { id: "fusionLead", value: "lead-b" },
    { id: "fusionEffort", value: "high" },
    { id: "fusionSidekick", value: "glm-5-2" },
    { id: "fastMode", value: true },
    { id: "__providerVariant", value: "fusion-lead-b-high-fast-sidekick-glm-5-2" },
  ]);
});

it("uses a deterministic valid variant for stale visible values", () => {
  const normalized = normalizeProviderOptionSelections({
    caps: fusionCaps,
    selections: [
      { id: "fusionLead", value: "missing-lead" },
      { id: "__providerVariant", value: "fusion-no-longer-in-catalog" },
    ],
  });

  expect(normalized?.at(-1)).toEqual({
    id: "__providerVariant",
    value: "fusion-lead-a-medium-sidekick-swe-2-medium",
  });
});
```

Also assert that a capability object without `optionVariants` produces the exact existing output from `buildProviderOptionSelectionsFromDescriptors`.

- [ ] **Step 2: Run the shared tests to verify they fail**

Run:

```bash
vp test run packages/shared/src/model.test.ts
```

Expected: FAIL because the new helpers and variant-aware descriptor filtering do not exist.

- [ ] **Step 3: Add cloning and variant-aware helper logic**

Extend `createModelCapabilities` and `cloneDescriptor`/capability handling to retain `optionVariants`. Add the reserved ID and implement the two helpers with these exact rules:

```ts
export const PROVIDER_OPTION_VARIANT_SELECTION_ID = "__providerVariant";

export function normalizeProviderOptionSelections(input: {
  readonly caps: ModelCapabilities | null | undefined;
  readonly selections: ReadonlyArray<ProviderOptionSelection> | null | undefined;
}): Array<ProviderOptionSelection> | undefined {
  const variants = input.caps?.optionVariants ?? [];
  if (variants.length === 0) {
    return input.selections?.map((selection) => ({ ...selection }));
  }

  const descriptorIds = new Set(
    (input.caps?.optionDescriptors ?? []).map((descriptor) => descriptor.id),
  );
  const current = new Map(
    (input.selections ?? [])
      .filter((selection) => descriptorIds.has(selection.id))
      .map((selection) => [selection.id, selection.value] as const),
  );
  const exactInternal = input.selections?.find(
    (selection) => selection.id === PROVIDER_OPTION_VARIANT_SELECTION_ID,
  )?.value;
  const exact =
    typeof exactInternal === "string"
      ? variants.find(
          (variant) =>
            variant.model === exactInternal &&
            variant.selections.every((selection) => current.get(selection.id) === selection.value),
        )
      : undefined;
  const selected =
    exact ??
    variants
      .map((variant, index) => ({
        variant,
        index,
        matches: variant.selections.reduce(
          (count, selection) => count + (current.get(selection.id) === selection.value ? 1 : 0),
          0,
        ),
      }))
      .sort((left, right) => right.matches - left.matches || left.index - right.index)[0]?.variant;
  if (!selected) return input.selections?.map((selection) => ({ ...selection }));

  const unrelated = (input.selections ?? []).filter(
    (selection) =>
      !descriptorIds.has(selection.id) && selection.id !== PROVIDER_OPTION_VARIANT_SELECTION_ID,
  );
  return [
    ...unrelated,
    ...selected.selections.map((selection) => ({ ...selection })),
    { id: PROVIDER_OPTION_VARIANT_SELECTION_ID, value: selected.model },
  ];
}

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
```

Complete the implementation by making the variant score prefer a supplied visible value whenever at least one row supports it, then prefer catalog-declared defaults before catalog order. For each select descriptor, retain only choices that occur in at least one row compatible with the other current visible values. Boolean descriptors keep their current value from the selected row. The exact internal selection must be replaced whenever the visible selections no longer match the previously stored variant.

Ensure `getProviderOptionDescriptors` does not return the internal selection as a descriptor. Preserve unknown non-variant option IDs so other provider options are not lost.

- [ ] **Step 4: Run the shared tests and typecheck**

Run:

```bash
vp test run packages/shared/src/model.test.ts
vp run --filter @t3tools/shared typecheck
```

Expected: PASS, including all pre-existing independent-option and custom-model tests.

- [ ] **Step 5: Commit the shared resolver**

```bash
git add packages/shared/src/model.ts packages/shared/src/model.test.ts
git commit -m "feat(shared): normalize constrained model options"
```

## Task 3: Parse Devin Fusion as a catalog-backed model family

**Files:**

- Modify: `apps/server/src/provider/Layers/DevinProvider.ts`
- Modify: `apps/server/src/provider/Layers/DevinProvider.test.ts`

**Interfaces:**

- Produces `parseDevinFusionModelUid(uid: string): { leadModel: string; leadEffort: string; sidekick: string; fastMode: boolean } | null` for direct parser tests.
- Produces one `ServerProviderModel` with `slug: "fusion"`, `name: "Fusion"`, `subProvider: "Fusion"`, visible descriptors, `optionVariants`, and exact-UID `pricingByVariant` entries.
- Keeps `parseDevinModelUid` and generic family grouping unchanged for every non-Fusion family.

- [ ] **Step 1: Add failing Fusion parser and grouping tests**

Add current catalog-shaped cases before changing the provider implementation:

```ts
it("parses lead, effort, sidekick variant, and standard mode", () => {
  expect(parseDevinFusionModelUid("fusion-claude-fable-5-1-high-sidekick-swe-2-medium")).toEqual({
    leadModel: "claude-fable-5-1",
    leadEffort: "high",
    sidekick: "swe-2-medium",
    fastMode: false,
  });
});

it("parses Fast Mode from the lead fast marker and sidekick priority marker", () => {
  expect(
    parseDevinFusionModelUid("fusion-gpt-5-6-sol-high-fast-sidekick-swe-2-medium")?.fastMode,
  ).toBe(true);
  expect(
    parseDevinFusionModelUid(
      "fusion-claude-fable-5-1-medium-fast-sidekick-gpt-5-6-luna-high-priority",
    ),
  ).toEqual({
    leadModel: "claude-fable-5-1",
    leadEffort: "medium",
    sidekick: "gpt-5-6-luna-high",
    fastMode: true,
  });
});

it("emits one Fusion model with exact valid variants", () => {
  const models = buildDevinModelsFromPayload({
    families: [
      {
        family_label: "Fusion",
        family_uid: "fusion",
        variants: [
          {
            model_uid: "fusion-claude-fable-5-1-high-sidekick-swe-2-medium",
            label: "Fable 5.1 High + SWE-2 Medium",
          },
          {
            model_uid: "fusion-gpt-5-6-sol-high-fast-sidekick-swe-2-medium",
            label: "GPT Sol High Fast + SWE-2 Medium",
          },
        ],
      },
    ],
  });

  expect(models).toHaveLength(1);
  expect(models[0]?.slug).toBe("fusion");
  expect(models[0]?.capabilities?.optionVariants).toHaveLength(2);
  expect(models[0]?.capabilities?.optionDescriptors?.map((descriptor) => descriptor.id)).toEqual([
    "fusionLead",
    "fusionEffort",
    "fusionSidekick",
    "fastMode",
  ]);
});
```

Also test that malformed UIDs are skipped, that a Fusion UID is not grouped as generic `reasoning`, and that existing GLM/ordinary Devin fixtures retain their current model rows and pricing.

- [ ] **Step 2: Run the Devin provider tests to verify they fail**

Run:

```bash
vp test run apps/server/src/provider/Layers/DevinProvider.test.ts
```

Expected: FAIL because the generic parser currently collapses Fusion suffixes and `parseDevinFusionModelUid` is absent.

- [ ] **Step 3: Implement the dedicated Fusion parser and model builder**

Add a Fusion branch before the generic family loop and bump `DEVIN_MODEL_CATALOG_VERSION` from `devin-model-catalog-v3` to `devin-model-catalog-v4`.

Parse only the Fusion grammar: require the `fusion-` prefix, split at the `-sidekick-` boundary, remove a recognized lead effort suffix from the lead portion, remove the optional lead `-fast` marker, normalize a sidekick `-priority` marker into `fastMode: true`, and keep the remaining sidekick identifier as the stable sidekick choice value. Recognized lead effort values are exactly `none`, `low`, `medium`, `high`, `xhigh`, `max`, and `thinking`; an unknown or missing effort makes that catalog record unusable rather than routing it through the generic parser.

Build visible descriptors with these stable IDs:

```ts
[
  { id: "fusionLead", label: "Lead", type: "select" },
  { id: "fusionEffort", label: "Effort", type: "select" },
  { id: "fusionSidekick", label: "Sidekick", type: "select" },
  { id: "fastMode", label: "Fast Mode", type: "boolean" },
];
```

For each valid catalog record, add an `optionVariants` row whose selections contain those IDs and preserve the original `model_uid` in `model`. Deduplicate choices and variant UIDs in catalog order. Use the first catalog-declared valid row as the default when the payload has no explicit default marker; mark each descriptor choice/value from that row as default. Use the existing pricing/context helpers for the exact UID, retain `pricingByVariant`, and set `inputAudio: false` consistently with the existing Devin capability map. Do not send raw catalog payloads or cost-summary strings to clients.

Do not add a generic `reasoning` or `speed` descriptor for Fusion. Keep all ordinary families on the existing path.

- [ ] **Step 4: Run the provider tests and focused server typecheck**

Run:

```bash
vp test run apps/server/src/provider/Layers/DevinProvider.test.ts
vp run --filter t3 typecheck
```

Expected: PASS, including the existing generic model catalog and pricing assertions.

- [ ] **Step 5: Commit the Fusion catalog mapping**

```bash
git add apps/server/src/provider/Layers/DevinProvider.ts apps/server/src/provider/Layers/DevinProvider.test.ts
git commit -m "feat(devin): expose Fusion catalog variants"
```

## Task 4: Route exact Fusion UIDs through ACP and active sessions

**Files:**

- Modify: `apps/server/src/provider/acp/DevinAcpSupport.ts`
- Modify: `apps/server/src/provider/acp/DevinAcpSupport.test.ts`
- Modify: `apps/server/src/provider/Layers/DevinAdapter.ts`
- Modify: `apps/server/src/provider/Layers/DevinAdapter.test.ts`

**Interfaces:**

- Keeps `resolveDevinModelUid(model, options, fallbackModelUid?)` as the resolver used by all Devin adapter call sites.
- Keeps `resolveDevinAcpBaseModelId(model)` returning `"fusion"` for `fusion` and concrete `fusion-*` UIDs.
- Extends `applyDevinAcpModelSelection` with an optional `fallbackModelUid` used only when an active Fusion selection is missing `__providerVariant`.

- [ ] **Step 1: Add failing resolver tests**

Add these cases to `DevinAcpSupport.test.ts`:

```ts
const FUSION_UID = "fusion-claude-fable-5-1-high-sidekick-swe-2-medium";

it("routes the exact internal Fusion variant without generic suffix parsing", () => {
  expect(
    resolveDevinModelUid("fusion", [
      { id: "fusionLead", value: "claude-fable-5-1" },
      { id: "fusionEffort", value: "high" },
      { id: "fusionSidekick", value: "swe-2-medium" },
      { id: "fastMode", value: false },
      { id: PROVIDER_OPTION_VARIANT_SELECTION_ID, value: FUSION_UID },
    ]),
  ).toBe(FUSION_UID);
});

it("maps concrete Fusion UIDs to the stable session base", () => {
  expect(resolveDevinAcpBaseModelId(FUSION_UID)).toBe("fusion");
});

it("retains the active Fusion UID when an active client omits the internal selection", () => {
  expect(resolveDevinModelUid("fusion", [], FUSION_UID)).toBe(FUSION_UID);
});
```

Add an adapter test using the existing ACP mock wrapper that starts with the Fusion selection, sends a second turn with the same `fusion` base and exact variant option, and asserts that the session remains active without the standalone-model restart state transition. Keep the existing standalone model-change restart tests unchanged.

- [ ] **Step 2: Run ACP tests to verify they fail**

Run:

```bash
vp test run apps/server/src/provider/acp/DevinAcpSupport.test.ts
vp test run apps/server/src/provider/Layers/DevinAdapter.test.ts
```

Expected: FAIL because the resolver currently treats the last Fusion suffix as generic reasoning and has no fallback parameter.

- [ ] **Step 3: Add exact-UID resolution and fallback plumbing**

Import `PROVIDER_OPTION_VARIANT_SELECTION_ID` from `@t3tools/shared/model` and, at the start of `resolveDevinModelUid`, detect the Fusion family before `parseDevinModelUid`:

```ts
const base = resolveDevinAcpBaseModelId(model);
if (base === "fusion") {
  const internal = options?.find(
    (option) =>
      option.id === PROVIDER_OPTION_VARIANT_SELECTION_ID && typeof option.value === "string",
  )?.value;
  if (typeof internal === "string" && /^fusion-.+/u.test(internal.trim())) {
    return internal.trim();
  }
  if (model?.trim().startsWith("fusion-")) return model.trim();
  if (fallbackModelUid?.trim().startsWith("fusion-")) return fallbackModelUid.trim();
  return "fusion";
}
```

Make `resolveDevinAcpBaseModelId` recognize `fusion` and `fusion-*` before generic parsing. Thread `fallbackModelUid` through `applyDevinAcpModelSelection`, `applyRequestedSessionConfiguration`, the active `sendTurn` path, and the `activeModelUid` assignment. Keep the existing reasoning/context/speed recombination and fallback candidates for non-Fusion models exactly as they are.

Update adapter comments to describe same-family option changes rather than reasoning-only changes. When the base remains `fusion`, use `setModel` without a restart; when the base changes between Fusion and a standalone model, retain the existing restart path. A rejected in-session Fusion change must map to the existing typed ACP adapter error and must not silently select another pairing.

- [ ] **Step 4: Run ACP and server verification**

Run:

```bash
vp test run apps/server/src/provider/acp/DevinAcpSupport.test.ts
vp test run apps/server/src/provider/Layers/DevinAdapter.test.ts
vp run --filter t3 typecheck
```

Expected: PASS, with exact Fusion UIDs reaching the existing ACP model configuration path and all standalone Devin tests unchanged.

- [ ] **Step 5: Commit ACP routing**

```bash
git add apps/server/src/provider/acp/DevinAcpSupport.ts apps/server/src/provider/acp/DevinAcpSupport.test.ts apps/server/src/provider/Layers/DevinAdapter.ts apps/server/src/provider/Layers/DevinAdapter.test.ts
git commit -m "feat(devin): route Fusion variants through ACP"
```

## Task 5: Wire web model controls and dispatch through shared helpers

**Files:**

- Modify: `apps/web/src/components/chat/TraitsPicker.tsx`
- Modify: `apps/web/src/components/chat/TraitsPicker.test.ts`
- Modify: `apps/web/src/components/chat/composerProviderState.tsx`
- Modify: `apps/web/src/components/chat/composerProviderState.test.tsx`
- Modify: `apps/web/src/components/chat/modelFamilyGrouping.ts`
- Modify: `apps/web/src/components/chat/modelFamilyGrouping.test.ts`
- Modify: `apps/web/src/composerDraftStore.test.ts`

**Interfaces:**

- The existing traits picker remains the only web UI; it consumes `getProviderOptionDescriptors` and `buildProviderOptionSelectionsForModel`.
- `getReasoningLevelDescriptor` recognizes `fusionEffort` as the effort control.
- Composer dispatch retains `__providerVariant` while continuing to persist only explicit visible options for ordinary providers.

- [ ] **Step 1: Add failing web logic tests**

Extend the existing pure tests with a Fusion capability fixture. Assert that `buildTraitsTriggerDisplay` shows lead/effort/sidekick labels plus the Fast Mode icon without including `__providerVariant`, and assert that `getReasoningLevelDescriptor` selects the `fusionEffort` descriptor even when `fusionLead` is listed first.

Add a composer-provider-state assertion with a selected Fusion variant:

```ts
expect(state.modelOptionsForDispatch).toEqual(
  expect.arrayContaining([
    { id: "fusionLead", value: "claude-fable-5-1" },
    { id: "fusionEffort", value: "high" },
    { id: "__providerVariant", value: "fusion-claude-fable-5-1-high-sidekick-swe-2-medium" },
  ]),
);
```

Add a draft-store assertion that replacing Devin options preserves the internal variant selection and does not change another provider's options.

- [ ] **Step 2: Run the focused web tests to verify they fail**

Run:

```bash
vp test run --project unit apps/web/src/components/chat/TraitsPicker.test.ts
vp test run --project unit apps/web/src/components/chat/modelFamilyGrouping.test.ts
vp test run --project unit apps/web/src/components/chat/composerProviderState.test.tsx
vp test run --project unit apps/web/src/composerDraftStore.test.ts
```

Expected: FAIL because the web paths still rebuild options with the independent-descriptor helper and do not recognize `fusionEffort`.

- [ ] **Step 3: Use the shared resolver in every web option mutation path**

In `TraitsPicker.tsx`, include `caps` in the selected trait state destructuring and replace the direct update with:

```ts
updateModelOptions(
  buildProviderOptionSelectionsForModel({
    caps,
    descriptors: nextDescriptors,
  }),
);
```

In `composerProviderState.tsx`, replace the explicit-only builder with `buildProviderOptionSelectionsForModel({ caps, descriptors, explicitSelections: selections })` so a Fusion internal variant survives dispatch while ordinary providers keep their current explicit/default behavior.

In `modelFamilyGrouping.ts`, add `fusionEffort` to `REASONING_DESCRIPTOR_IDS`, and after changing the reasoning descriptor call `normalizeProviderOptionSelections({ caps, selections: next })` before returning. This keeps a selected Fusion effort and its dependent choices synchronized when the compact model picker changes effort.

Do not add Fusion-specific JSX, UID parsing, command-palette state, or desktop code. The existing descriptor loops must render all four controls, and `fastMode` must continue using the existing bolt presentation.

- [ ] **Step 4: Run web tests and typecheck**

Run:

```bash
vp test run --project unit apps/web/src/components/chat/TraitsPicker.test.ts
vp test run --project unit apps/web/src/components/chat/modelFamilyGrouping.test.ts
vp test run --project unit apps/web/src/components/chat/composerProviderState.test.tsx
vp test run --project unit apps/web/src/composerDraftStore.test.ts
vp run --filter @t3tools/web typecheck
```

Expected: PASS, with the existing traits, composer, draft, and non-Devin provider tests unchanged.

- [ ] **Step 5: Commit the web integration**

```bash
git add apps/web/src/components/chat/TraitsPicker.tsx apps/web/src/components/chat/TraitsPicker.test.ts apps/web/src/components/chat/composerProviderState.tsx apps/web/src/components/chat/composerProviderState.test.tsx apps/web/src/components/chat/modelFamilyGrouping.ts apps/web/src/components/chat/modelFamilyGrouping.test.ts apps/web/src/composerDraftStore.test.ts
git commit -m "feat(web): expose Devin Fusion controls"
```

## Task 6: Wire mobile settings and model-option persistence

**Files:**

- Modify: `apps/mobile/src/lib/providerOptions.ts`
- Modify: `apps/mobile/src/lib/providerOptions.test.ts`
- Modify: `apps/mobile/src/lib/modelOptions.ts`
- Modify: `apps/mobile/src/lib/modelOptions.test.ts`
- Modify: `apps/mobile/src/features/threads/ThreadSettingsSheet.tsx`
- Modify: `apps/mobile/src/features/threads/ThreadComposer.tsx`

**Interfaces:**

- `applyProviderOptionSelection(input: { capabilities: ModelCapabilities | null | undefined; descriptors: ReadonlyArray<ProviderOptionDescriptor>; change: ProviderOptionSelection }): ReadonlyArray<ProviderOptionSelection> | null` uses the shared model resolver.
- Existing-thread and new-task settings both pass the selected model's `ModelCapabilities` to the settings session.
- `buildModelOptions` retains `__providerVariant` when normalizing a saved Fusion selection.

- [ ] **Step 1: Add failing mobile helper and persistence tests**

Use the same two-row Fusion capability shape as Task 2 and assert that changing `fusionLead` returns all dependent visible selections plus the exact internal variant:

```ts
const next = applyProviderOptionSelection({
  capabilities: fusionCaps,
  descriptors: resolveProviderOptionDescriptors({
    capabilities: fusionCaps,
    selections: undefined,
  }),
  change: { id: "fusionLead", value: "lead-b" },
});

expect(next).toEqual([
  { id: "fusionLead", value: "lead-b" },
  { id: "fusionEffort", value: "high" },
  { id: "fusionSidekick", value: "glm-5-2" },
  { id: "fastMode", value: true },
  { id: "__providerVariant", value: "fusion-lead-b-high-fast-sidekick-glm-5-2" },
]);
```

Add a `buildModelOptions` test that feeds a Fusion `ServerConfig` and a selected `ModelSelection` containing `__providerVariant`, then asserts the returned `ModelOption.selection.options` still contains that exact value.

- [ ] **Step 2: Run mobile tests to verify they fail**

Run:

```bash
vp test run apps/mobile/src/lib/providerOptions.test.ts
vp test run apps/mobile/src/lib/modelOptions.test.ts
```

Expected: FAIL because mobile currently rebuilds selections from descriptors without capabilities and drops the internal variant.

- [ ] **Step 3: Pass capabilities through mobile option updates**

Change `applyProviderOptionSelection` to accept `{ capabilities, descriptors, change }`. After validating the changed descriptor, build the full descriptor selection and call `buildProviderOptionSelectionsForModel({ caps: capabilities, descriptors: nextDescriptors })`.

In `modelOptions.ts`, after resolving descriptors, use `buildProviderOptionSelectionsForModel({ caps: capabilities, descriptors, explicitSelections: selection.options })` rather than the existing explicit-only builder. This preserves explicit-option semantics and keeps `__providerVariant` as the one internal selection added for a constrained model.

In `ThreadSettingsSheet.tsx`, add `capabilities: ModelCapabilities | null` to `ThreadSettingsSessionProps`. For a pending model use `pendingModel.capabilities`; otherwise use the session's applied capabilities when calling `applyProviderOptionSelection`. Pass the current model option capabilities from `ThreadComposer.tsx` into the existing-thread settings route and from `flow.selectedModelOption?.capabilities` into the new-task settings session.

Keep `getProviderOptionDescriptors` as the source for submenu choices; no mobile component should inspect Devin-specific IDs or UIDs.

- [ ] **Step 4: Run mobile tests and typecheck**

Run:

```bash
vp test run apps/mobile/src/lib/providerOptions.test.ts
vp test run apps/mobile/src/lib/modelOptions.test.ts
vp run --filter @t3tools/mobile typecheck
```

Expected: PASS, including existing non-Fusion settings and unavailable-model behavior.

- [ ] **Step 5: Commit the mobile integration**

```bash
git add apps/mobile/src/lib/providerOptions.ts apps/mobile/src/lib/providerOptions.test.ts apps/mobile/src/lib/modelOptions.ts apps/mobile/src/lib/modelOptions.test.ts apps/mobile/src/features/threads/ThreadSettingsSheet.tsx apps/mobile/src/features/threads/ThreadComposer.tsx
git commit -m "feat(mobile): expose Devin Fusion controls"
```

## Task 7: Document the feature and verify the cross-surface contract

**Files:**

- Modify: `docs/user/providers-devin.md`
- Modify: `packages/contracts/src/model.test.ts`

**Interfaces:**

- User documentation describes how to select Fusion from T3's model controls and explains that available pairings come from the installed Devin CLI.
- Contract tests prove a `ServerProviderModel` carrying Fusion capabilities can be decoded by a remote client without Devin-specific client code.

- [ ] **Step 1: Add the user-guide section**

Add a concise section under the existing Devin model-picker guidance:

```md
### Fusion

When the installed Devin CLI exposes Fusion, select the Fusion model to choose
its lead model, lead effort, sidekick, and Fast Mode. T3 reads the available
pairings from Devin, so options can vary by CLI version or account. The same
selection is used in web, desktop, mobile, and remote sessions.
```

Do not document internal option IDs or model UID syntax.

- [ ] **Step 2: Add the remote capability decode assertion**

Decode a `ServerProviderModel` containing `capabilities.optionVariants` through the existing `ServerProviderModel` schema and assert that the exact `fusion-*` model value survives. This covers the `ServerConfig`/WebSocket contract used by remote, relay, and tunnel clients.

- [ ] **Step 3: Run final focused verification**

Run the touched tests and typechecks without starting a browser or simulator:

```bash
vp test run packages/contracts/src/model.test.ts
vp test run packages/shared/src/model.test.ts
vp test run apps/server/src/provider/Layers/DevinProvider.test.ts
vp test run apps/server/src/provider/acp/DevinAcpSupport.test.ts
vp test run apps/server/src/provider/Layers/DevinAdapter.test.ts
vp test run --project unit apps/web/src/components/chat/TraitsPicker.test.ts
vp test run --project unit apps/web/src/components/chat/modelFamilyGrouping.test.ts
vp test run --project unit apps/web/src/components/chat/composerProviderState.test.tsx
vp test run apps/mobile/src/lib/providerOptions.test.ts
vp test run apps/mobile/src/lib/modelOptions.test.ts
vp run --filter t3 typecheck
vp run --filter @t3tools/web typecheck
vp run --filter @t3tools/mobile typecheck
```

Expected: all focused tests and typechecks pass. The final committed feature range contains exactly one commit per task, so the post-commit check in Step 5 uses `git diff --check HEAD~7..HEAD` and does not include the earlier design commit or unrelated user work.

- [ ] **Step 4: Commit documentation and final verification updates**

```bash
git add docs/user/providers-devin.md packages/contracts/src/model.test.ts
git commit -m "docs(devin): explain Fusion model controls"
```

- [ ] **Step 5: Check the committed feature range**

Run:

```bash
git diff --check HEAD~7..HEAD
git status --short
```

Expected: the feature range has no whitespace errors or conflict markers. The status output may still list the pre-existing untracked user files, which must remain unstaged.

## Completion checks

- A current Devin catalog produces one `fusion` model with valid Lead, Effort, Sidekick, and Fast Mode controls.
- Changing any advertised control selects a valid catalog pairing and retains its exact UID in `__providerVariant`.
- New and active Devin ACP sessions receive the exact selected UID; same-family changes do not trigger a standalone-model restart.
- Web, desktop, mobile, and remote selections display the same visible values and preserve the same internal variant.
- Older/non-Fusion providers retain their current option behavior.
- Focused server, shared, contract, web, and mobile tests/typechecks pass.
- The Devin guide is accurate and contains no implementation-only details.
