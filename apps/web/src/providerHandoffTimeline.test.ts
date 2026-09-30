import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { decodeProviderHandoffInfo, providerHandoffCardModel } from "./providerHandoffTimeline";

function provider(input: {
  provider: ProviderDriverKind;
  instanceId: string;
  displayName?: string;
}): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make(input.instanceId),
    driver: input.provider,
    ...(input.displayName ? { displayName: input.displayName } : {}),
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-01-01T00:00:00.000Z",
    models: [],
    slashCommands: [],
    skills: [],
    rules: [],
  };
}

describe("decodeProviderHandoffInfo", () => {
  it("decodes a full success payload", () => {
    const info = decodeProviderHandoffInfo({
      kind: "provider.handoff",
      payload: {
        fromProvider: "claudeAgent",
        fromInstanceId: "claudeAgent",
        toInstanceId: "codex",
        brief: "We were mid-refactor.",
        degraded: false,
      },
    });

    expect(info).toEqual({
      outcome: "success",
      fromProvider: "claudeAgent",
      fromInstanceId: "claudeAgent",
      toInstanceId: "codex",
      brief: "We were mid-refactor.",
      degraded: false,
    });
  });

  it("degrades missing and malformed fields to null instead of throwing", () => {
    expect(decodeProviderHandoffInfo({ kind: "provider.handoff", payload: null })).toEqual({
      outcome: "success",
      fromProvider: null,
      fromInstanceId: null,
      toInstanceId: null,
      brief: null,
      degraded: false,
    });
    expect(
      decodeProviderHandoffInfo({
        kind: "provider.handoff",
        // A space breaks the driver slug pattern, so the field decodes null.
        payload: { fromProvider: "not a driver", brief: 42, degraded: "yes" },
      }),
    ).toEqual({
      outcome: "success",
      fromProvider: null,
      fromInstanceId: null,
      toInstanceId: null,
      brief: null,
      degraded: false,
    });
  });

  it("decodes the failure payload", () => {
    expect(
      decodeProviderHandoffInfo({
        kind: "provider.handoff.failed",
        payload: { detail: "Provider 'codex' does not support provider handoff." },
      }),
    ).toEqual({
      outcome: "failure",
      detail: "Provider 'codex' does not support provider handoff.",
    });
  });

  it("returns null for unrelated activity kinds", () => {
    expect(decodeProviderHandoffInfo({ kind: "tool.call", payload: { detail: "x" } })).toBeNull();
  });
});

describe("providerHandoffCardModel", () => {
  const providers = [
    provider({ provider: ProviderDriverKind.make("claudeAgent"), instanceId: "claudeAgent" }),
    provider({
      provider: ProviderDriverKind.make("codex"),
      instanceId: "codex",
      displayName: "Codex Work",
    }),
  ];

  it("is null without decoded info", () => {
    expect(providerHandoffCardModel({ info: undefined, providers })).toBeNull();
  });

  it("titles the card with the live instance display names", () => {
    const info = decodeProviderHandoffInfo({
      kind: "provider.handoff",
      payload: {
        fromProvider: "claudeAgent",
        fromInstanceId: "claudeAgent",
        toInstanceId: "codex",
        brief: "We were mid-refactor.",
        degraded: false,
      },
    });

    const model = providerHandoffCardModel({ info: info ?? undefined, providers });
    // A snapshot displayName wins over humanizing the instance id; the
    // default instance falls back to the driver brand label.
    expect(model?.title).toBe("Claude → Codex Work");
    expect(model?.body).toBe("We were mid-refactor.");
    expect(model?.failed).toBe(false);
    expect(model?.degraded).toBe(false);
  });

  it("falls back to humanized ids for instances deleted from the catalog", () => {
    const info = decodeProviderHandoffInfo({
      kind: "provider.handoff",
      payload: {
        fromProvider: "claudeAgent",
        fromInstanceId: "claude_personal",
        toInstanceId: "codex_removed",
        brief: "brief",
        degraded: true,
      },
    });

    const model = providerHandoffCardModel({ info: info ?? undefined, providers: [] });
    expect(model?.title).toBe("Claude Personal → Codex Removed");
    expect(model?.degraded).toBe(true);
  });

  it("falls back to the driver display name when no source instance was recorded", () => {
    const info = decodeProviderHandoffInfo({
      kind: "provider.handoff",
      payload: { fromProvider: "claudeAgent", toInstanceId: "codex", brief: "b" },
    });

    const model = providerHandoffCardModel({ info: info ?? undefined, providers });
    expect(model?.title).toBe("Claude → Codex Work");
  });

  it("names the destination alone when the source is unrecoverable", () => {
    const info = decodeProviderHandoffInfo({
      kind: "provider.handoff",
      payload: { toInstanceId: "codex", brief: "b" },
    });

    const model = providerHandoffCardModel({ info: info ?? undefined, providers });
    expect(model?.title).toBe("Handed off to Codex Work");
  });

  it("renders failures as their own card with the server detail", () => {
    const info = decodeProviderHandoffInfo({
      kind: "provider.handoff.failed",
      payload: { detail: "Provider 'codex' does not support provider handoff." },
    });

    const model = providerHandoffCardModel({ info: info ?? undefined, providers });
    expect(model).toEqual({
      failed: true,
      title: "Provider handoff failed",
      body: "Provider 'codex' does not support provider handoff.",
      degraded: false,
    });
  });
});
