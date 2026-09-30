/**
 * Reader for the Devin ACP provider's usage records.
 *
 * Devin has no CLI transcript directory: the T3 server's canonical event log
 * (`providerLogsDir/events.*.log`) records `thread.token-usage.updated` events
 * with per-turn token deltas, so this module parses those log lines into
 * `UsageRecord`s that share the generic transcript-reader streaming pipeline.
 *
 * @module devinUsageReader
 */
import type { UsageTokenTotals } from "@t3tools/contracts";

import { totalTokens, type UsageRecord } from "./usageTranscripts.ts";

function parseTimestampMs(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

function nonNegative(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.trunc(value) : 0;
}

function parseProviderEventLogLine(line: string): {
  readonly loggedAtMs: number | null;
  readonly event: Record<string, unknown>;
} | null {
  // EventNdjsonLogger prefixes every record with a human-readable timestamp
  // and stream label. Only canonical records are useful here; native ACP
  // payloads do not have stable token accounting semantics.
  const match = /^\[([^\]\r\n]+)\]\s+([A-Z]+):\s+(.+)$/u.exec(line);
  if (!match || match[2] !== "CANON") return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(match[3] ?? "");
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;

  return {
    loggedAtMs: parseTimestampMs(match[1]),
    event: parsed as Record<string, unknown>,
  };
}

/**
 * Parses a canonical Devin ACP token-usage event from a provider event log.
 *
 * Context-only `usage_update` notifications are intentionally ignored. The
 * corresponding canonical event carries `usedTokens`/`maxTokens`, but no
 * per-turn token delta, so counting it would double count the prompt record.
 */
export function parseDevinCanonicalLogLine(line: string): UsageRecord | null {
  const parsed = parseProviderEventLogLine(line);
  if (parsed === null) return null;

  const event = parsed.event;
  if (event.provider !== "devin" || event.type !== "thread.token-usage.updated") return null;
  const payload = event.payload;
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return null;
  const usage = (payload as Record<string, unknown>)["usage"];
  if (typeof usage !== "object" || usage === null || Array.isArray(usage)) return null;
  const usageRecord = usage as Record<string, unknown>;

  const hasTurnBreakdown = [
    "lastInputTokens",
    "lastCachedInputTokens",
    "lastCacheCreationTokens",
    "lastOutputTokens",
    "lastReasoningOutputTokens",
  ].some((key) => typeof usageRecord[key] === "number" && Number.isFinite(usageRecord[key]));
  if (!hasTurnBreakdown) return null;

  const lastInputTokens = nonNegative(usageRecord["lastInputTokens"]);
  const cachedInputTokens = nonNegative(usageRecord["lastCachedInputTokens"]);
  const cacheCreationTokens = nonNegative(usageRecord["lastCacheCreationTokens"]);
  const outputTokens = nonNegative(usageRecord["lastOutputTokens"]);
  const reasoningTokens = Math.min(
    outputTokens,
    nonNegative(usageRecord["lastReasoningOutputTokens"]),
  );
  const totals: UsageTokenTotals = {
    uncachedInputTokens: Math.max(0, lastInputTokens - cachedInputTokens - cacheCreationTokens),
    cachedInputTokens,
    cacheCreationTokens,
    outputTokens,
    reasoningTokens,
  };
  if (totalTokens(totals) === 0) return null;

  const createdAtMs = parseTimestampMs(event.createdAt) ?? parsed.loggedAtMs;
  if (createdAtMs === null) return null;

  const model =
    typeof usageRecord.model === "string" && usageRecord.model.trim().length > 0
      ? usageRecord.model.trim()
      : "devin";
  const sessionId =
    typeof usageRecord.providerSessionId === "string" &&
    usageRecord.providerSessionId.trim().length > 0
      ? usageRecord.providerSessionId.trim()
      : typeof event.threadId === "string"
        ? event.threadId
        : "";
  const reportedCostUsd =
    typeof usageRecord.lastCostUsd === "number" &&
    Number.isFinite(usageRecord.lastCostUsd) &&
    usageRecord.lastCostUsd >= 0
      ? usageRecord.lastCostUsd
      : null;

  return {
    provider: "devin",
    timestampMs: createdAtMs,
    model,
    sessionId,
    totals,
    fast: false,
    reportedCostUsd,
    dedupeKey: typeof event.eventId === "string" ? event.eventId : null,
  };
}
