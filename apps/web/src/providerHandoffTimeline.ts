/**
 * Timeline side of provider handoff: decoding the `provider.handoff` /
 * `provider.handoff.failed` activities and shaping their dedicated card.
 * Kept free of the picker/model-selection imports so `session-logic` can
 * decode payloads without pulling the model picker into its module graph.
 *
 * @module providerHandoffTimeline
 */
import {
  isProviderDriverKind,
  PROVIDER_DISPLAY_NAMES,
  type OrchestrationThreadActivity,
  type ProviderDriverKind,
  type ServerProvider,
} from "@t3tools/contracts";
import {
  humanizeSlug,
  resolveProviderInstanceDisplayName,
} from "@t3tools/client-runtime/state/provider-instance-display";

/**
 * Decoded `provider.handoff` activity payload, kept on the work-log entry so
 * the timeline can render the dedicated card instead of a generic row.
 */
export type ProviderHandoffInfo =
  | {
      readonly outcome: "success";
      readonly fromProvider: ProviderDriverKind | null;
      readonly fromInstanceId: string | null;
      readonly toInstanceId: string | null;
      readonly brief: string | null;
      readonly degraded: boolean;
    }
  | {
      readonly outcome: "failure";
      readonly detail: string | null;
    };

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

const asTrimmedString = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

/**
 * Read the payload of a `provider.handoff` / `provider.handoff.failed`
 * activity. Payloads arrive as `unknown` from the wire; every field degrades
 * to null rather than throwing so an older or partial payload still renders
 * a card.
 */
export function decodeProviderHandoffInfo(
  activity: Pick<OrchestrationThreadActivity, "kind" | "payload">,
): ProviderHandoffInfo | null {
  const payload = asRecord(activity.payload);
  if (activity.kind === "provider.handoff.failed") {
    return { outcome: "failure", detail: asTrimmedString(payload?.detail) };
  }
  if (activity.kind !== "provider.handoff") {
    return null;
  }
  const fromProvider = asTrimmedString(payload?.fromProvider);
  return {
    outcome: "success",
    fromProvider: isProviderDriverKind(fromProvider) ? fromProvider : null,
    fromInstanceId: asTrimmedString(payload?.fromInstanceId),
    toInstanceId: asTrimmedString(payload?.toInstanceId),
    brief: asTrimmedString(payload?.brief),
    degraded: payload?.degraded === true,
  };
}

export interface ProviderHandoffCardModel {
  readonly failed: boolean;
  /** `Claude → Codex`, or `Provider handoff failed` on failure. */
  readonly title: string;
  /** The handoff brief, or the failure detail. */
  readonly body: string | null;
  /**
   * True when the outgoing provider could not write a summary and the card
   * carries the deterministic fallback brief.
   */
  readonly degraded: boolean;
}

/** Instance display name when the catalog still has it, else a humanized id. */
function handoffEndpointLabel(
  providers: ReadonlyArray<ServerProvider>,
  instanceId: string | null,
  fallbackDriver: ProviderDriverKind | null,
): string | null {
  if (instanceId !== null) {
    const snapshot = providers.find((provider) => provider.instanceId === instanceId);
    if (snapshot) {
      return resolveProviderInstanceDisplayName(snapshot);
    }
    const humanized = humanizeSlug(instanceId);
    if (humanized.length > 0) {
      return humanized;
    }
  }
  if (fallbackDriver !== null) {
    return PROVIDER_DISPLAY_NAMES[fallbackDriver] ?? humanizeSlug(fallbackDriver);
  }
  return null;
}

/**
 * Presentation model for the handoff timeline card. Provider labels resolve
 * against the live catalog first (display names move), falling back to the
 * ids recorded in the activity payload so the card survives deleted
 * instances.
 */
export function providerHandoffCardModel(input: {
  readonly info: ProviderHandoffInfo | undefined;
  readonly providers: ReadonlyArray<ServerProvider>;
}): ProviderHandoffCardModel | null {
  const info = input.info;
  if (info === undefined) {
    return null;
  }
  if (info.outcome === "failure") {
    return {
      failed: true,
      title: "Provider handoff failed",
      body: info.detail,
      degraded: false,
    };
  }
  const fromLabel = handoffEndpointLabel(input.providers, info.fromInstanceId, info.fromProvider);
  const toLabel = handoffEndpointLabel(input.providers, info.toInstanceId, null);
  const title =
    fromLabel !== null && toLabel !== null
      ? `${fromLabel} → ${toLabel}`
      : toLabel !== null
        ? `Handed off to ${toLabel}`
        : "Provider handoff";
  return {
    failed: false,
    title,
    body: info.brief,
    degraded: info.degraded,
  };
}
