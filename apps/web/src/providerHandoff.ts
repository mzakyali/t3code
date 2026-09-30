/**
 * Provider handoff: continuing a started thread on a different provider
 * instance. This module owns the client-side eligibility rules (which
 * instances may receive a handoff); the `provider.handoff` /
 * `provider.handoff.failed` timeline decode + card model live in
 * `providerHandoffTimeline`, which stays clear of the model-picker imports.
 *
 * @module providerHandoff
 */
import type {
  OrchestrationThreadShell,
  ProviderInstanceId,
  ServerProvider,
} from "@t3tools/contracts";
import type { UnifiedSettings } from "@t3tools/contracts/settings";

import { getAppModelOptionsForInstance, type AppModelOption } from "./modelSelection";
import {
  applyProviderInstanceSettings,
  deriveProviderInstanceEntries,
  isProviderInstancePickerReady,
  sortProviderInstanceEntries,
  type ProviderInstanceEntry,
} from "./providerInstances";

/**
 * The instance the thread's provider work runs on right now: the live
 * session's binding wins over the stored selection, which the handoff meta
 * update rewrites once the move lands.
 */
export function providerHandoffSourceInstanceId(
  thread: Pick<OrchestrationThreadShell, "session" | "modelSelection"> | null | undefined,
): ProviderInstanceId | null {
  return thread?.session?.providerInstanceId ?? thread?.modelSelection.instanceId ?? null;
}

/**
 * Instances eligible as a provider-handoff destination. A destination must
 * advertise `supportsProviderHandoff` in its snapshot, be able to start a
 * session now (picker-ready: enabled, available, probed), offer at least
 * one selectable model (an all-unavailable catalog does not count), and run
 * a different driver than the thread's current provider — the server
 * rejects same-driver moves, so they never appear in the picker.
 *
 * A known source instance that does not itself support handoff yields no
 * destinations at all: the move cannot start. A source missing from the
 * catalog (deleted instance) skips the driver check — the server stays
 * authoritative for the edge case.
 */
export function deriveProviderHandoffDestinations(input: {
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly settings: UnifiedSettings;
  readonly currentInstanceId: ProviderInstanceId | null | undefined;
}): ReadonlyArray<ProviderInstanceEntry> {
  const entries = sortProviderInstanceEntries(
    applyProviderInstanceSettings(deriveProviderInstanceEntries(input.providers), input.settings),
  );
  const currentEntry =
    input.currentInstanceId !== null && input.currentInstanceId !== undefined
      ? entries.find((entry) => entry.instanceId === input.currentInstanceId)
      : undefined;
  if (currentEntry !== undefined && currentEntry.snapshot.supportsProviderHandoff !== true) {
    return [];
  }
  return entries.filter(
    (entry) =>
      entry.snapshot.supportsProviderHandoff === true &&
      isProviderInstancePickerReady(entry) &&
      entry.instanceId !== input.currentInstanceId &&
      (currentEntry === undefined || entry.driverKind !== currentEntry.driverKind) &&
      getAppModelOptionsForInstance(input.settings, entry).some(
        (option) => option.isUnavailable !== true,
      ),
  );
}

/** Per-instance model options for the handoff picker, matching the composer. */
export function deriveProviderHandoffModelOptions(
  settings: UnifiedSettings,
  destinations: ReadonlyArray<ProviderInstanceEntry>,
): ReadonlyMap<ProviderInstanceId, ReadonlyArray<AppModelOption>> {
  return new Map(
    destinations.map((entry) => [entry.instanceId, getAppModelOptionsForInstance(settings, entry)]),
  );
}
