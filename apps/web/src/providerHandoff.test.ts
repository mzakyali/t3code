import {
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationSession,
  type OrchestrationThreadShell,
  type ServerProvider,
  type ServerSettings,
} from "@t3tools/contracts";
import { DEFAULT_UNIFIED_SETTINGS, type UnifiedSettings } from "@t3tools/contracts/settings";
import { describe, expect, it } from "vite-plus/test";

import {
  deriveProviderHandoffDestinations,
  deriveProviderHandoffModelOptions,
  providerHandoffSourceInstanceId,
} from "./providerHandoff";

const CODEX = ProviderDriverKind.make("codex");
const CLAUDE = ProviderDriverKind.make("claudeAgent");

function provider(input: {
  provider: ProviderDriverKind;
  instanceId: string;
  supportsProviderHandoff?: boolean | undefined;
  enabled?: boolean;
  availability?: ServerProvider["availability"];
  status?: ServerProvider["status"];
  models?: ServerProvider["models"];
}): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make(input.instanceId),
    driver: input.provider,
    ...(input.supportsProviderHandoff !== undefined
      ? { supportsProviderHandoff: input.supportsProviderHandoff }
      : {}),
    enabled: input.enabled ?? true,
    installed: true,
    version: null,
    status: input.status ?? "ready",
    ...(input.availability ? { availability: input.availability } : {}),
    auth: { status: "authenticated" },
    checkedAt: "2026-01-01T00:00:00.000Z",
    models: input.models ?? [],
    slashCommands: [],
    skills: [],
    rules: [],
  };
}

const model = (slug: string): ServerProvider["models"][number] => ({
  slug,
  name: slug,
  isCustom: false,
  capabilities: {},
});

function settingsWith(
  providerInstances: ServerSettings["providerInstances"] = {},
): UnifiedSettings {
  return { ...DEFAULT_UNIFIED_SETTINGS, providerInstances };
}

const HANDOFF_CAPABLE_CLAUDE = provider({
  provider: CLAUDE,
  instanceId: "claudeAgent",
  supportsProviderHandoff: true,
  models: [model("claude-opus-4-8")],
});
const HANDOFF_CAPABLE_CODEX = provider({
  provider: CODEX,
  instanceId: "codex",
  supportsProviderHandoff: true,
  models: [model("gpt-5.6")],
});

describe("deriveProviderHandoffDestinations", () => {
  it("offers a ready, handoff-capable instance of a different driver", () => {
    const destinations = deriveProviderHandoffDestinations({
      providers: [HANDOFF_CAPABLE_CODEX, HANDOFF_CAPABLE_CLAUDE],
      settings: settingsWith(),
      currentInstanceId: ProviderInstanceId.make("codex"),
    });

    expect(destinations.map((entry) => entry.instanceId)).toEqual(["claudeAgent"]);
  });

  it("excludes same-driver instances, including custom ones", () => {
    const custom = provider({
      provider: CODEX,
      instanceId: "codex_personal",
      supportsProviderHandoff: true,
      models: [model("gpt-5.6-mini")],
    });
    const settings = settingsWith({
      [ProviderInstanceId.make("codex_personal")]: { driver: CODEX, enabled: true },
    });

    const destinations = deriveProviderHandoffDestinations({
      providers: [HANDOFF_CAPABLE_CODEX, custom, HANDOFF_CAPABLE_CLAUDE],
      settings,
      currentInstanceId: ProviderInstanceId.make("codex"),
    });

    expect(destinations.map((entry) => entry.instanceId)).toEqual(["claudeAgent"]);
  });

  it("excludes the current instance itself", () => {
    const destinations = deriveProviderHandoffDestinations({
      providers: [HANDOFF_CAPABLE_CODEX, HANDOFF_CAPABLE_CLAUDE],
      settings: settingsWith(),
      currentInstanceId: ProviderInstanceId.make("codex"),
    });

    expect(destinations.some((entry) => entry.instanceId === "codex")).toBe(false);
  });

  it.each([
    ["does not advertise the capability", { supportsProviderHandoff: undefined }],
    ["is disabled", { supportsProviderHandoff: true, enabled: false }],
    ["is unavailable", { supportsProviderHandoff: true, availability: "unavailable" as const }],
    ["has not probed ready", { supportsProviderHandoff: true, status: "warning" as const }],
    ["offers no selectable model", { supportsProviderHandoff: true, models: [] }],
  ])("excludes a destination that %s", (_label, overrides) => {
    const destination = provider({
      provider: CLAUDE,
      instanceId: "claudeAgent",
      ...overrides,
    });

    const destinations = deriveProviderHandoffDestinations({
      providers: [HANDOFF_CAPABLE_CODEX, destination],
      settings: settingsWith(),
      currentInstanceId: ProviderInstanceId.make("codex"),
    });

    expect(destinations).toEqual([]);
  });

  it("offers no destination when the source instance cannot hand off", () => {
    const incapableSource = provider({
      provider: CODEX,
      instanceId: "codex",
      supportsProviderHandoff: false,
      models: [model("gpt-5.6")],
    });

    const destinations = deriveProviderHandoffDestinations({
      providers: [incapableSource, HANDOFF_CAPABLE_CLAUDE],
      settings: settingsWith(),
      currentInstanceId: ProviderInstanceId.make("codex"),
    });

    expect(destinations).toEqual([]);
  });

  it("skips the driver check when the source instance left the catalog", () => {
    const destinations = deriveProviderHandoffDestinations({
      providers: [HANDOFF_CAPABLE_CODEX, HANDOFF_CAPABLE_CLAUDE],
      settings: settingsWith(),
      currentInstanceId: ProviderInstanceId.make("deleted_instance"),
    });

    // The deleted source's driver is unknown, so both instances remain
    // candidates — the server stays authoritative for this edge case.
    expect(destinations.map((entry) => entry.instanceId)).toEqual(["codex", "claudeAgent"]);
  });

  it("treats an unknown source id as no source filter at all", () => {
    const destinations = deriveProviderHandoffDestinations({
      providers: [HANDOFF_CAPABLE_CODEX, HANDOFF_CAPABLE_CLAUDE],
      settings: settingsWith(),
      currentInstanceId: null,
    });

    expect(destinations.map((entry) => entry.instanceId)).toEqual(["codex", "claudeAgent"]);
  });

  it("excludes a destination whose models are all hidden", () => {
    const destination = provider({
      provider: CLAUDE,
      instanceId: "claudeAgent",
      supportsProviderHandoff: true,
      models: [model("claude-opus-4-8")],
    });
    const settings = {
      ...settingsWith(),
      providerModelPreferences: {
        [ProviderInstanceId.make("claudeAgent")]: {
          hiddenModels: ["claude-opus-4-8"],
          modelOrder: [],
        },
      },
    };

    const destinations = deriveProviderHandoffDestinations({
      providers: [HANDOFF_CAPABLE_CODEX, destination],
      settings,
      currentInstanceId: ProviderInstanceId.make("codex"),
    });

    expect(destinations).toEqual([]);
  });

  it("disables a destination whose settings entry was removed", () => {
    // Custom instances absent from providerInstances resolve as disabled.
    const custom = provider({
      provider: CLAUDE,
      instanceId: "claude_work",
      supportsProviderHandoff: true,
      models: [model("claude-opus-4-8")],
    });

    const destinations = deriveProviderHandoffDestinations({
      providers: [HANDOFF_CAPABLE_CODEX, custom],
      settings: settingsWith(),
      currentInstanceId: ProviderInstanceId.make("codex"),
    });

    expect(destinations).toEqual([]);
  });
});

describe("deriveProviderHandoffModelOptions", () => {
  it("maps each destination to its own model list", () => {
    const custom = provider({
      provider: CLAUDE,
      instanceId: "claude_work",
      supportsProviderHandoff: true,
      models: [model("claude-fable-5")],
    });
    const settings = settingsWith({
      [ProviderInstanceId.make("claude_work")]: { driver: CLAUDE, enabled: true },
    });
    const destinations = deriveProviderHandoffDestinations({
      providers: [HANDOFF_CAPABLE_CODEX, HANDOFF_CAPABLE_CLAUDE, custom],
      settings,
      currentInstanceId: ProviderInstanceId.make("codex"),
    });

    const options = deriveProviderHandoffModelOptions(settings, destinations);

    expect(options.get(ProviderInstanceId.make("claudeAgent"))?.map((o) => o.slug)).toEqual([
      "claude-opus-4-8",
    ]);
    expect(options.get(ProviderInstanceId.make("claude_work"))?.map((o) => o.slug)).toEqual([
      "claude-fable-5",
    ]);
  });
});

describe("providerHandoffSourceInstanceId", () => {
  const shell = (
    session: OrchestrationSession | null,
    instanceId: string,
  ): Pick<OrchestrationThreadShell, "session" | "modelSelection"> => ({
    session,
    modelSelection: { instanceId: ProviderInstanceId.make(instanceId), model: "m" },
  });

  it("prefers the live session binding over the stored selection", () => {
    const session: OrchestrationSession = {
      threadId: ThreadId.make("t"),
      status: "ready",
      providerName: "codex",
      providerInstanceId: ProviderInstanceId.make("codex"),
      runtimeMode: "full-access",
      activeTurnId: null,
      lastError: null,
      updatedAt: "2026-01-01T00:00:00.000Z",
    };

    expect(providerHandoffSourceInstanceId(shell(session, "claudeAgent"))).toBe("codex");
  });

  it("falls back to the stored selection when no session exists", () => {
    expect(providerHandoffSourceInstanceId(shell(null, "claudeAgent"))).toBe("claudeAgent");
  });

  it("returns null for a missing thread", () => {
    expect(providerHandoffSourceInstanceId(null)).toBeNull();
    expect(providerHandoffSourceInstanceId(undefined)).toBeNull();
  });
});
