import { describe, expect, it } from "@effect/vitest";

import { parseDevinCanonicalLogLine } from "./devinUsageReader.ts";

describe("parseDevinCanonicalLogLine", () => {
  const contextOnly = JSON.stringify({
    type: "thread.token-usage.updated",
    eventId: "event-context",
    createdAt: "2026-08-10T12:00:00.000Z",
    provider: "devin",
    threadId: "thread-1",
    payload: { usage: { usedTokens: 4_000, maxTokens: 200_000 } },
  });

  const promptUsage = JSON.stringify({
    type: "thread.token-usage.updated",
    eventId: "event-prompt",
    createdAt: "2026-08-10T12:00:01.000Z",
    provider: "devin",
    threadId: "thread-1",
    payload: {
      usage: {
        model: "gpt-5-6-luna-medium",
        providerSessionId: "acp-session-1",
        lastInputTokens: 1_200,
        lastCachedInputTokens: 300,
        lastCacheCreationTokens: 100,
        lastOutputTokens: 80,
        lastReasoningOutputTokens: 20,
        lastCostUsd: 0.0125,
      },
    },
  });

  it("ignores context-only updates so they cannot double count prompts", () => {
    expect(
      parseDevinCanonicalLogLine(`[2026-08-10T12:00:00.000Z] CANON: ${contextOnly}`),
    ).toBeNull();
  });

  it("maps ACP turn deltas, model/session identity, and cost", () => {
    const record = parseDevinCanonicalLogLine(`[2026-08-10T12:00:01.000Z] CANON: ${promptUsage}`);

    expect(record).toEqual({
      provider: "devin",
      timestampMs: Date.parse("2026-08-10T12:00:01.000Z"),
      model: "gpt-5-6-luna-medium",
      sessionId: "acp-session-1",
      totals: {
        uncachedInputTokens: 800,
        cachedInputTokens: 300,
        cacheCreationTokens: 100,
        outputTokens: 80,
        reasoningTokens: 20,
      },
      fast: false,
      reportedCostUsd: 0.0125,
      dedupeKey: "event-prompt",
    });
  });

  it("accepts rotated-log lines and falls back to thread identity", () => {
    const event = JSON.parse(promptUsage) as Record<string, unknown>;
    const payload = event.payload as Record<string, unknown>;
    const usage = payload.usage as Record<string, unknown>;
    delete usage.providerSessionId;
    delete usage.model;
    delete event.createdAt;
    const record = parseDevinCanonicalLogLine(
      `[2026-08-10T12:00:01.000Z] CANON: ${JSON.stringify(event)}`,
    );

    expect(record?.model).toBe("devin");
    expect(record?.sessionId).toBe("thread-1");
    expect(record?.timestampMs).toBe(Date.parse("2026-08-10T12:00:01.000Z"));
  });
});
