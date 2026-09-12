# Devin Fusion cross-surface model controls

**Status:** Draft for written-spec review
**Date:** 2026-09-12

## Goal

Expose Devin Fusion as one selectable model with the same user control that
Devin CLI provides: lead model, lead effort, sidekick, and Fast Mode. The
selection must work through T3's web, desktop, mobile, and remote connection
surfaces while routing the exact Fusion model UID selected from the current
Devin catalog.

The implementation must keep Fusion-specific parsing and UID resolution at the
Devin provider boundary. Clients should consume a provider-neutral capability
contract and must not parse Devin model UIDs.

## Context and current gap

Devin's catalog contains a `fusion` family whose concrete UIDs encode a lead,
lead effort, optional fast tier, and sidekick variant. The current Devin parser
interprets trailing Fusion segments as ordinary reasoning and speed suffixes,
then collapses unrelated pairings into one generic model row. The current
option contract also assumes that select choices are independent, although the
Fusion catalog publishes a non-uniform set of valid pairings.

The local Devin CLI catalog currently exposes about 210 Fusion variants. The
number and exact IDs are provider data and must not be hardcoded. A future CLI
may add or remove leads, sidekicks, efforts, or pairings.

## User experience

The model picker shows one `Fusion` model. Its existing model-options/traits
surfaces expose:

- Lead — the frontier model driving the session.
- Effort — the lead's reasoning effort.
- Sidekick — the cost-efficient execution model. If the catalog distinguishes
  sidekick effort or speed, the choice label includes that distinction; if the
  catalog exposes it as an independent valid dimension, it becomes a separate
  dependent control.
- Fast Mode — a boolean control that selects faster variants where Devin
  advertises them.

The controls are populated from the installed CLI's current catalog. A user can
change any advertised choice, but the UI only offers values that can produce a
valid Fusion pairing. Changing one value may update dependent values to the
nearest valid catalog pairing. The exact provider UID is an internal routing
detail and is not required to be manually typed by the user.

The selected controls persist with the existing model selection. Returning to a
thread, opening it on another device, or switching between local and remote
connections restores the same pairing when it is still present in the current
catalog.

Devin documents these controls and the fact that Fast Mode swaps to faster
variants at higher cost in its [Fusion CLI documentation](https://docs.devin.ai/cli/fusion).

## Chosen approach

Use a provider-neutral option-variant table in `ModelCapabilities`, with the
Devin provider supplying the table and the existing web/mobile option helpers
enforcing it.

Add an optional contract type with this semantic shape:

```ts
ProviderOptionVariant = {
  model: string; // exact provider model UID
  selections: Array<ProviderOptionSelection>; // visible option values
};
```

`ModelCapabilities.optionVariants` is optional. Existing providers that have
independent options remain unchanged. The variant table is metadata, not a
second model catalog: the model row still has a stable slug (`fusion`) and
clients still render the normal option descriptors.

The shared model helpers will add a variant-aware normalization operation. It
will:

1. Read the current visible selections and defaults.
2. Find a valid variant that preserves the explicit choice and as many other
   current values as possible.
3. Update dependent visible values and filter each select's choices to values
   participating in at least one valid variant for the current state.
4. Preserve the exact variant model UID in an internal reserved selection,
   `__providerVariant`, so the server can route without reconstructing a UID
   from labels or suffixes.

The internal selection is not represented by a visible descriptor. It is
ignored by clients when rendering and is retained when model options are
serialized. A provider that uses variants must not publish a user-facing
descriptor with the reserved ID.

The normalizer uses deterministic tie-breaking: preserve the newly changed
value, maximize matches with the previous selections, prefer catalog-declared
defaults when available, then use catalog order. Invalid or stale selections
are normalized to a valid variant rather than sent to Devin.

## Devin catalog mapping

`buildDevinModelsFromPayload` will route the `family_uid === "fusion"` family to
a Fusion-specific parser before the generic Devin UID parser. The parser will:

- Split the lead and sidekick portions at the provider's `sidekick` boundary.
- Parse the lead model and effort independently from sidekick effort/speed.
- Detect Fast Mode from the catalog's structured fields when present, with a
  narrowly scoped UID fallback for known current catalog shapes.
- Create stable, human-readable choice IDs and labels from catalog values.
- Preserve each valid concrete `model_uid` as a `ProviderOptionVariant.model`.
- Deduplicate variants and visible choices while retaining catalog order.
- Preserve safe catalog descriptions and existing numeric pricing metadata where
  available. Existing `pricingByVariant` remains keyed by the exact UID.
- Skip malformed or unparseable variants without allowing one bad record to
  invalidate the rest of the provider snapshot.

The emitted model will have:

```text
slug: fusion
name: Fusion
subProvider: Fusion
capabilities.optionDescriptors: visible Fusion controls
capabilities.optionVariants: exact UID-to-selection mapping
```

The default is the first provider-declared/default valid variant. The provider
must not assume a fixed lead, sidekick, or variant count. The context meter uses
the lead/catalog context value only when a single reliable value exists; it
must omit or conservatively choose a value rather than report a sidekick
context as the lead limit.

The generic parser remains responsible for ordinary Devin families. Its
existing reasoning, speed, context-window, opaque UID, and pricing behavior
must not regress.

## ACP dispatch and session behavior

`resolveDevinModelUid` will recognize `__providerVariant` for the Fusion model
and return its exact UID after basic family validation. It must not parse a
Fusion UID as a generic `reasoning`/`speed` combination. The base-model helper
will map both `fusion` and known concrete Fusion UIDs to the stable base
`fusion` so model-option changes follow the existing in-session configuration
path.

For a new session, the selected exact UID is applied through the existing Devin
ACP model configuration. For an active Fusion session, changing the pairing
uses the existing `setModel` path; switching between Fusion and a standalone
model follows the existing base-model change/restart behavior. If Devin rejects
an in-session pairing change, the adapter reports the typed provider error and
does not silently send the next turn under a different pairing.

Selections missing the internal variant ID can occur with old clients or old
persisted state. The adapter must use the safe Fusion family default available
to the current provider configuration, or retain the current exact UID when
one is already active. It must never synthesize an unchecked UID from arbitrary
visible labels.

Usage and active-model state continue to use the exact UID. Devin's dual lead +
sidekick billing breakdown and savings presentation are not recreated as a new
T3 usage UI in this slice unless the existing provider usage payload exposes
both rates in a form that can be represented accurately. No cost estimate may
pretend that one model rate represents both models.

## Shared contract and client surfaces

### Contracts and shared runtime

- Add `ProviderOptionVariant` and optional `ModelCapabilities.optionVariants`.
- Keep both fields optional for wire and persisted compatibility.
- Add shared helpers for variant normalization, compatible choice filtering,
  and internal exact-UID selection retention.
- Ensure descriptor cloning, current-value resolution, explicit-selection
  normalization, custom model decoding, and model option persistence preserve
  ordinary behavior when no variants exist.
- Keep the internal variant selection out of user-facing labels and prompts.

### Web and desktop

The web traits/model picker will continue to render generic descriptors. It
will hide no new special component; it will call the shared variant normalizer
when a Fusion choice changes and will display the resolved visible values in
the existing trigger. The desktop client inherits this behavior from the web
bundle and needs no separate Fusion implementation.

The same capability lookup must be used by chat composer settings, new-task
model selection, thread model settings, and any existing settings model picker.
There must be no second web-only Fusion state.

### Mobile

The mobile thread-settings and new-task flows will use the same shared
variant-aware helper. Select submenus will show only compatible values, and a
pending model change will carry the exact internal variant selection when it is
committed. Mobile must not duplicate Devin UID parsing.

### Remote, relay, and tunnel connections

The server remains the source of truth for Devin discovery and parsing. The
capabilities and variant table cross the existing typed `ServerProviderModel`
inside `ServerConfig`; clients never need Devin credentials or a local Devin
binary. Local, remote, relay, and tunnel connections therefore use the same
selection semantics. An older client that does not understand `optionVariants`
falls back to the stable Fusion family/default behavior until upgraded; it
must not receive an invalid model UID.

## Failure, compatibility, and performance behavior

- Devin CLI versions/plans that do not advertise Fusion simply do not expose a
  Fusion model row.
- A failed model probe preserves the existing provider snapshot behavior and
  does not break ordinary Devin sessions.
- A malformed Fusion record is skipped with bounded provider diagnostics.
- If no valid Fusion variants remain, Fusion is omitted rather than exposed as
  a misleading generic model.
- A catalog refresh invalidates the old grouped snapshot using the Devin model
  catalog version marker and re-normalizes stored selections against the new
  variant table.
- An exact UID missing from a refreshed catalog resolves to the deterministic
  nearest valid/default variant; stale options are never sent unchecked.
- The variant table is compact: visible choices are deduplicated and each
  variant carries only its exact UID plus normalized selections. Raw catalog
  payloads and cost summaries are not sent to clients.
- Existing providers, custom models, and non-Fusion Devin model families keep
  their current option behavior.

## Verification plan

### Contracts and shared helpers

- Decode and encode capabilities with and without `optionVariants`.
- Normalize a valid Fusion selection to its exact internal UID.
- Filter incompatible choices and update dependent values after a change.
- Recover deterministically from stale, partial, and invalid selections.
- Prove ordinary independent descriptors and custom models are unchanged.

### Devin provider and ACP

- Parse representative current Fusion UIDs for every lead, effort, sidekick,
  sidekick variant, and Fast Mode shape.
- Prove the emitted model is one `fusion` row with the expected descriptors
  and exact variant table rather than generic reasoning/speed groups.
- Skip malformed/unknown records without dropping valid records.
- Preserve existing generic Devin parsing and pricing tests.
- Resolve exact Fusion UIDs from `__providerVariant`, map concrete UIDs back to
  the `fusion` base, and cover missing/stale internal selections.
- Verify active-session changes and standalone-to-Fusion transitions use the
  correct ACP path and error behavior.

### Web, mobile, and remote contract

- Exercise the web traits logic with constrained descriptors without asserting
  implementation-only callback wiring.
- Exercise mobile option application and pending model settings with the same
  constrained capability fixture.
- Decode a `ServerProviderModel` containing Fusion capabilities through the
  server/client contract boundary.
- Verify desktop's inherited web path requires no separate provider logic.

Verification remains focused on touched tests and typechecks. A real integrated
web/mobile pass should use the repository's isolated test skills only after the
user explicitly authorizes browser or simulator control. A live Devin turn is
optional and must use the isolated worktree state, never the shared T3 home.

## Rollout order

1. Add the optional contract shape and shared variant normalization with
   provider-neutral tests.
2. Add the Fusion-specific catalog parser, model snapshot, pricing/context
   handling, and catalog-version bump.
3. Add exact ACP dispatch and session-change coverage.
4. Wire web, desktop-inherited, mobile, settings, and remote paths to the
   shared helpers.
5. Update the Devin user guide and run focused verification across each layer.

The implementation is complete only when a current Fusion catalog can be
selected from web and mobile, the same selection survives a remote round trip,
and Devin ACP receives the exact corresponding model UID.
