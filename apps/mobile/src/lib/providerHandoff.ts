/**
 * Provider handoff: continuing a started thread on a different provider
 * instance. This module owns the mobile eligibility rules (which instances
 * may receive a handoff), mirroring the web gates in
 * `apps/web/src/providerHandoff.ts`; the `provider.handoff` /
 * `provider.handoff.failed` timeline decode + card model live in
 * `@t3tools/client-runtime/work-log/provider-handoff`.
 *
 * @module providerHandoff
 */
import {
  isProviderAvailable,
  type OrchestrationThreadShell,
  type ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";

import type { ModelOption, ProviderGroup } from "./modelOptions";

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
 * Whether the thread has any history worth handing off: a started turn, a
 * user message, or a live session. Same definition as the web menu gate.
 */
export function threadShellHasStarted(
  thread: Pick<OrchestrationThreadShell, "latestTurn" | "latestUserMessageAt" | "session"> | null,
): boolean {
  return Boolean(
    thread &&
    (thread.latestTurn !== null || thread.latestUserMessageAt !== null || thread.session !== null),
  );
}

/**
 * Instances eligible as a provider-handoff destination. A destination must
 * advertise `supportsProviderHandoff` in its snapshot, be able to start a
 * session now (enabled, installed, authenticated, available, probed ready —
 * the union of this app's picker gate and the web's picker-ready check),
 * offer at least one selectable model in `modelOptions` (the composer's
 * `buildModelOptions` output), and run a different driver than the thread's
 * current provider — the server rejects same-driver moves, so they never
 * appear in the picker.
 *
 * A known source instance that does not itself support handoff yields no
 * destinations at all: the move cannot start. A source missing from the
 * catalog (deleted instance) skips the driver check — the server stays
 * authoritative for the edge case.
 */
export function deriveProviderHandoffDestinations(input: {
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly modelOptions: ReadonlyArray<ModelOption>;
  readonly currentInstanceId: ProviderInstanceId | null | undefined;
}): ReadonlyArray<ServerProvider> {
  const current =
    input.currentInstanceId !== null && input.currentInstanceId !== undefined
      ? input.providers.find((provider) => provider.instanceId === input.currentInstanceId)
      : undefined;
  if (current !== undefined && current.supportsProviderHandoff !== true) {
    return [];
  }
  return input.providers.filter(
    (provider) =>
      provider.supportsProviderHandoff === true &&
      provider.enabled &&
      provider.installed &&
      provider.auth.status !== "unauthenticated" &&
      provider.status === "ready" &&
      isProviderAvailable(provider) &&
      provider.instanceId !== input.currentInstanceId &&
      (current === undefined || provider.driver !== current.driver) &&
      input.modelOptions.some(
        (option) => option.providerKey === provider.instanceId && option.isUnavailable !== true,
      ),
  );
}

/**
 * The picker groups for a handoff session: the composer's provider groups
 * narrowed to eligible destinations with unavailable models dropped. Group
 * order follows the provider catalog, matching the settings sheet.
 */
export function deriveProviderHandoffGroups(input: {
  readonly destinations: ReadonlyArray<ServerProvider>;
  readonly providerGroups: ReadonlyArray<ProviderGroup>;
}): ReadonlyArray<ProviderGroup> {
  const destinationIds = new Set<string>(
    input.destinations.map((destination) => destination.instanceId),
  );
  return input.providerGroups
    .filter((group) => destinationIds.has(group.providerKey))
    .map((group) => ({
      ...group,
      models: group.models.filter((option) => option.isUnavailable !== true),
    }))
    .filter((group) => group.models.length > 0);
}
