import { describe, expect, it } from "vite-plus/test";

import {
  ProviderDriverKind,
  ProviderInstanceId,
  type OrchestrationThreadShell,
  type ServerProvider,
} from "@t3tools/contracts";

import type { ModelOption, ProviderGroup } from "./modelOptions";
import {
  deriveProviderHandoffDestinations,
  deriveProviderHandoffGroups,
  providerHandoffSourceInstanceId,
  threadShellHasStarted,
} from "./providerHandoff";

const CODEX = ProviderDriverKind.make("codex");
const CLAUDE = ProviderDriverKind.make("claudeAgent");

function provider(input: {
  provider: ProviderDriverKind;
  instanceId: string;
  supportsProviderHandoff?: boolean | undefined;
  enabled?: boolean;
  installed?: boolean;
  availability?: ServerProvider["availability"];
  status?: ServerProvider["status"];
  auth?: ServerProvider["auth"];
  models?: ServerProvider["models"];
}): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make(input.instanceId),
    driver: input.provider,
    ...(input.supportsProviderHandoff !== undefined
      ? { supportsProviderHandoff: input.supportsProviderHandoff }
      : {}),
    enabled: input.enabled ?? true,
    installed: input.installed ?? true,
    version: null,
    status: input.status ?? "ready",
    ...(input.availability ? { availability: input.availability } : {}),
    auth: input.auth ?? { status: "authenticated" },
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

const modelOption = (providerKey: string, isUnavailable?: boolean): ModelOption => ({
  key: `${providerKey}:model`,
  label: "Model",
  subtitle: "",
  providerKey,
  providerLabel: providerKey,
  providerDriver: "codex",
  isDefault: false,
  isLegacy: false,
  ...(isUnavailable !== undefined ? { isUnavailable } : {}),
  capabilities: null,
  selection: { instanceId: ProviderInstanceId.make(providerKey), model: "model" },
});

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

const claudeOptions = [modelOption("claudeAgent")];
const codexOptions = [modelOption("codex")];

describe("providerHandoffSourceInstanceId", () => {
  it("prefers the live session binding over the stored selection", () => {
    const thread = {
      session: { providerInstanceId: ProviderInstanceId.make("claudeAgent") },
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.6" },
    } as unknown as OrchestrationThreadShell;

    expect(providerHandoffSourceInstanceId(thread)).toBe("claudeAgent");
  });

  it("falls back to the stored selection and then null", () => {
    const thread = {
      session: null,
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.6" },
    } as unknown as OrchestrationThreadShell;

    expect(providerHandoffSourceInstanceId(thread)).toBe("codex");
    expect(providerHandoffSourceInstanceId(null)).toBeNull();
  });
});

describe("threadShellHasStarted", () => {
  const fresh = {
    latestTurn: null,
    latestUserMessageAt: null,
    session: null,
  } as unknown as OrchestrationThreadShell;

  it("is false before the thread has any history", () => {
    expect(threadShellHasStarted(fresh)).toBe(false);
    expect(threadShellHasStarted(null)).toBe(false);
  });

  it.each([
    ["a settled turn", { latestTurn: { id: "turn-1" } }],
    ["a user message", { latestUserMessageAt: "2026-09-01T00:00:00.000Z" }],
    ["a live session", { session: { status: "idle" } }],
  ])("is true once the thread has %s", (_label, field) => {
    expect(
      threadShellHasStarted({ ...fresh, ...field } as unknown as OrchestrationThreadShell),
    ).toBe(true);
  });
});

describe("deriveProviderHandoffDestinations", () => {
  it("offers a ready, handoff-capable instance of a different driver", () => {
    const destinations = deriveProviderHandoffDestinations({
      providers: [HANDOFF_CAPABLE_CODEX, HANDOFF_CAPABLE_CLAUDE],
      modelOptions: [...codexOptions, ...claudeOptions],
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

    const destinations = deriveProviderHandoffDestinations({
      providers: [HANDOFF_CAPABLE_CODEX, custom, HANDOFF_CAPABLE_CLAUDE],
      modelOptions: [...codexOptions, modelOption("codex_personal"), ...claudeOptions],
      currentInstanceId: ProviderInstanceId.make("codex"),
    });

    expect(destinations.map((entry) => entry.instanceId)).toEqual(["claudeAgent"]);
  });

  it("excludes the current instance itself", () => {
    const destinations = deriveProviderHandoffDestinations({
      providers: [HANDOFF_CAPABLE_CODEX, HANDOFF_CAPABLE_CLAUDE],
      modelOptions: [...codexOptions, ...claudeOptions],
      currentInstanceId: ProviderInstanceId.make("codex"),
    });

    expect(destinations.some((entry) => entry.instanceId === "codex")).toBe(false);
  });

  it.each([
    ["does not advertise the capability", { supportsProviderHandoff: undefined }],
    ["is disabled", { supportsProviderHandoff: true, enabled: false }],
    ["is not installed", { supportsProviderHandoff: true, installed: false }],
    [
      "is signed out",
      { supportsProviderHandoff: true, auth: { status: "unauthenticated" as const } },
    ],
    ["is unavailable", { supportsProviderHandoff: true, availability: "unavailable" as const }],
    ["has not probed ready", { supportsProviderHandoff: true, status: "warning" as const }],
  ])("excludes a destination that %s", (_label, overrides) => {
    const destination = provider({
      provider: CLAUDE,
      instanceId: "claudeAgent",
      ...overrides,
    });

    const destinations = deriveProviderHandoffDestinations({
      providers: [HANDOFF_CAPABLE_CODEX, destination],
      modelOptions: [...codexOptions, ...claudeOptions],
      currentInstanceId: ProviderInstanceId.make("codex"),
    });

    expect(destinations).toEqual([]);
  });

  it("excludes a destination whose catalog has no selectable model", () => {
    const destinations = deriveProviderHandoffDestinations({
      providers: [HANDOFF_CAPABLE_CODEX, HANDOFF_CAPABLE_CLAUDE],
      modelOptions: [...codexOptions, modelOption("claudeAgent", true)],
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
      modelOptions: [...codexOptions, ...claudeOptions],
      currentInstanceId: ProviderInstanceId.make("codex"),
    });

    expect(destinations).toEqual([]);
  });

  it("skips the driver check when the source instance left the catalog", () => {
    const destinations = deriveProviderHandoffDestinations({
      providers: [HANDOFF_CAPABLE_CODEX, HANDOFF_CAPABLE_CLAUDE],
      modelOptions: [...codexOptions, ...claudeOptions],
      currentInstanceId: ProviderInstanceId.make("deleted_instance"),
    });

    // The deleted source's driver is unknown, so both instances remain
    // candidates — the server stays authoritative for this edge case.
    expect(destinations.map((entry) => entry.instanceId)).toEqual(["codex", "claudeAgent"]);
  });

  it("treats an unknown source id as no source filter at all", () => {
    const destinations = deriveProviderHandoffDestinations({
      providers: [HANDOFF_CAPABLE_CODEX, HANDOFF_CAPABLE_CLAUDE],
      modelOptions: [...codexOptions, ...claudeOptions],
      currentInstanceId: null,
    });

    expect(destinations.map((entry) => entry.instanceId)).toEqual(["codex", "claudeAgent"]);
  });
});

describe("deriveProviderHandoffGroups", () => {
  const group = (providerKey: string, options: ReadonlyArray<ModelOption>): ProviderGroup => ({
    providerKey,
    providerLabel: providerKey,
    models: options,
  });

  it("keeps only destination groups and drops unavailable models", () => {
    const groups = deriveProviderHandoffGroups({
      destinations: [HANDOFF_CAPABLE_CLAUDE],
      providerGroups: [
        group("codex", codexOptions),
        group("claudeAgent", [modelOption("claudeAgent", true), modelOption("claudeAgent")]),
      ],
    });

    expect(groups).toHaveLength(1);
    expect(groups[0]?.providerKey).toBe("claudeAgent");
    expect(groups[0]?.models.map((option) => option.key)).toEqual(["claudeAgent:model"]);
    expect(groups[0]?.models[0]?.isUnavailable).toBeUndefined();
  });

  it("drops destination groups that would render empty", () => {
    const groups = deriveProviderHandoffGroups({
      destinations: [HANDOFF_CAPABLE_CLAUDE],
      providerGroups: [group("claudeAgent", [modelOption("claudeAgent", true)])],
    });

    expect(groups).toEqual([]);
  });
});
