import { describe, expect, it } from "vite-plus/test";
import { ProviderDriverKind, ProviderInstanceId, type ModelCapabilities } from "@t3tools/contracts";

import {
  applyClaudePromptEffortPrefix,
  buildExplicitProviderOptionSelectionsFromDescriptors,
  buildProviderOptionSelectionsFromDescriptors,
  createModelCapabilities,
  createModelSelection,
  getCompatibleProviderOptionValues,
  getModelInputCapabilities,
  getModelSelectionBooleanOptionValue,
  getModelSelectionStringOptionValue,
  getProviderOptionDescriptors,
  normalizeProviderOptionSelections,
  readCustomModelEntries,
  resolveProviderOptionVariant,
  toCustomModelSetting,
  getProviderOptionBooleanSelectionValue,
  getProviderOptionStringSelectionValue,
  normalizeCustomModelSlug,
  normalizeModelSlug,
} from "./model.ts";

const codexCaps: ModelCapabilities = createModelCapabilities({
  optionDescriptors: [
    {
      id: "reasoningEffort",
      label: "Reasoning",
      type: "select",
      options: [
        { id: "xhigh", label: "Extra High" },
        { id: "high", label: "High", isDefault: true },
      ],
      currentValue: "high",
    },
    {
      id: "fastMode",
      label: "Fast Mode",
      type: "boolean",
    },
  ],
});

const claudeCaps: ModelCapabilities = createModelCapabilities({
  optionDescriptors: [
    {
      id: "effort",
      label: "Reasoning",
      type: "select",
      options: [
        { id: "medium", label: "Medium" },
        { id: "high", label: "High", isDefault: true },
        { id: "ultrathink", label: "Ultrathink" },
      ],
      currentValue: "high",
      promptInjectedValues: ["ultrathink"],
    },
    {
      id: "contextWindow",
      label: "Context Window",
      type: "select",
      options: [
        { id: "200k", label: "200k" },
        { id: "1m", label: "1M", isDefault: true },
      ],
      currentValue: "1m",
    },
  ],
});

describe("descriptor helpers", () => {
  it("applies selection values to capability descriptors", () => {
    expect(
      getProviderOptionDescriptors({
        caps: claudeCaps,
        selections: [
          { id: "effort", value: "medium" },
          { id: "contextWindow", value: "200k" },
        ],
      }),
    ).toEqual([
      {
        id: "effort",
        label: "Reasoning",
        type: "select",
        options: [
          { id: "medium", label: "Medium" },
          { id: "high", label: "High", isDefault: true },
          { id: "ultrathink", label: "Ultrathink" },
        ],
        currentValue: "medium",
        promptInjectedValues: ["ultrathink"],
      },
      {
        id: "contextWindow",
        label: "Context Window",
        type: "select",
        options: [
          { id: "200k", label: "200k" },
          { id: "1m", label: "1M", isDefault: true },
        ],
        currentValue: "200k",
      },
    ]);
  });

  it("builds wire-format option selections from descriptors", () => {
    const descriptors = getProviderOptionDescriptors({
      caps: codexCaps,
      selections: [
        { id: "reasoningEffort", value: "high" },
        { id: "fastMode", value: true },
      ],
    });

    expect(buildProviderOptionSelectionsFromDescriptors(descriptors)).toEqual([
      { id: "reasoningEffort", value: "high" },
      { id: "fastMode", value: true },
    ]);
  });

  it("builds dispatch options only from explicit selections", () => {
    const descriptors = getProviderOptionDescriptors({
      caps: codexCaps,
      selections: [{ id: "fastMode", value: true }],
    });

    expect(buildExplicitProviderOptionSelectionsFromDescriptors(descriptors, undefined)).toBe(
      undefined,
    );
    expect(
      buildExplicitProviderOptionSelectionsFromDescriptors(descriptors, [
        { id: "fastMode", value: true },
      ]),
    ).toEqual([{ id: "fastMode", value: true }]);
  });

  it("stores option selection arrays in model selections", () => {
    expect(
      createModelSelection(ProviderInstanceId.make("codex"), "gpt-5.4", [
        { id: "reasoningEffort", value: "high" },
        { id: "fastMode", value: true },
      ]),
    ).toEqual({
      instanceId: "codex",
      model: "gpt-5.4",
      options: [
        { id: "reasoningEffort", value: "high" },
        { id: "fastMode", value: true },
      ],
    });
  });

  it("reads typed option selection values", () => {
    const selection = createModelSelection(ProviderInstanceId.make("codex"), "gpt-5.4", [
      { id: "reasoningEffort", value: "high" },
      { id: "fastMode", value: true },
    ]);

    expect(getProviderOptionStringSelectionValue(selection.options, "reasoningEffort")).toBe(
      "high",
    );
    expect(getProviderOptionStringSelectionValue(selection.options, "fastMode")).toBeUndefined();
    expect(getProviderOptionBooleanSelectionValue(selection.options, "fastMode")).toBe(true);
    expect(
      getProviderOptionBooleanSelectionValue(selection.options, "reasoningEffort"),
    ).toBeUndefined();
    expect(getModelSelectionStringOptionValue(selection, "reasoningEffort")).toBe("high");
    expect(getModelSelectionBooleanOptionValue(selection, "fastMode")).toBe(true);
  });
});

/** A small fusion-style variant table: dependent lead/effort/sidekick/fast. */
const fusionCaps: ModelCapabilities = createModelCapabilities({
  optionDescriptors: [
    {
      id: "lead",
      label: "Lead",
      type: "select",
      options: [
        { id: "opus", label: "Opus", isDefault: true },
        { id: "luna", label: "Luna" },
      ],
      currentValue: "opus",
    },
    {
      id: "effort",
      label: "Effort",
      type: "select",
      options: [
        { id: "high", label: "High", isDefault: true },
        { id: "low", label: "Low" },
      ],
      currentValue: "high",
    },
    {
      id: "sidekick",
      label: "Sidekick",
      type: "select",
      options: [
        { id: "swe-2", label: "SWE-2", isDefault: true },
        { id: "swe-2-medium", label: "SWE-2 Medium" },
        { id: "swe-2-high", label: "SWE-2 High" },
        { id: "glm-priority", label: "GLM Priority" },
      ],
      currentValue: "swe-2",
    },
    { id: "fastMode", label: "Fast Mode", type: "boolean", currentValue: false },
  ],
  optionVariants: [
    {
      model: "fusion-opus-high-sidekick-swe-2",
      selections: [
        { id: "lead", value: "opus" },
        { id: "effort", value: "high" },
        { id: "sidekick", value: "swe-2" },
        { id: "fastMode", value: false },
      ],
    },
    {
      model: "fusion-opus-high-fast-sidekick-swe-2-medium",
      selections: [
        { id: "lead", value: "opus" },
        { id: "effort", value: "high" },
        { id: "sidekick", value: "swe-2-medium" },
        { id: "fastMode", value: true },
      ],
    },
    {
      model: "fusion-opus-high-sidekick-swe-2-high",
      selections: [
        { id: "lead", value: "opus" },
        { id: "effort", value: "high" },
        { id: "sidekick", value: "swe-2-high" },
        { id: "fastMode", value: false },
      ],
    },
    {
      model: "fusion-luna-low-sidekick-glm-priority",
      selections: [
        { id: "lead", value: "luna" },
        { id: "effort", value: "low" },
        { id: "sidekick", value: "glm-priority" },
        { id: "fastMode", value: false },
      ],
    },
  ],
});

describe("provider option variants", () => {
  it("normalizes a bare selection to the best matching variant and emits __providerVariant", () => {
    expect(
      normalizeProviderOptionSelections({
        caps: fusionCaps,
        selections: [
          { id: "lead", value: "luna" },
          { id: "effort", value: "low" },
          { id: "sidekick", value: "glm-priority" },
          { id: "fastMode", value: false },
        ],
      }),
    ).toEqual([
      { id: "lead", value: "luna" },
      { id: "effort", value: "low" },
      { id: "sidekick", value: "glm-priority" },
      { id: "fastMode", value: false },
      { id: "__providerVariant", value: "fusion-luna-low-sidekick-glm-priority" },
    ]);
  });

  it("moves dependent selections to a valid pairing when the current one cannot exist", () => {
    // luna+high is not a catalog combination; the resolver must shift to a
    // variant that satisfies the pinned lead.
    const normalized = normalizeProviderOptionSelections({
      caps: fusionCaps,
      selections: [
        { id: "lead", value: "luna" },
        { id: "effort", value: "high" },
        { id: "sidekick", value: "swe-2" },
        { id: "fastMode", value: false },
      ],
      pinnedIds: ["lead"],
    });
    expect(normalized).toEqual([
      { id: "lead", value: "luna" },
      { id: "effort", value: "low" },
      { id: "sidekick", value: "glm-priority" },
      { id: "fastMode", value: false },
      { id: "__providerVariant", value: "fusion-luna-low-sidekick-glm-priority" },
    ]);
  });

  it("prefers a still-valid carried variant over re-deriving from visible picks", () => {
    const variant = resolveProviderOptionVariant({
      caps: fusionCaps,
      selections: [
        { id: "lead", value: "opus" },
        { id: "effort", value: "high" },
        { id: "sidekick", value: "swe-2-medium" },
        { id: "fastMode", value: true },
        { id: "__providerVariant", value: "fusion-opus-high-fast-sidekick-swe-2-medium" },
      ],
    });
    expect(variant?.model).toBe("fusion-opus-high-fast-sidekick-swe-2-medium");
  });

  it("lets explicit selections outrank a stale carried variant", () => {
    const normalized = buildExplicitProviderOptionSelectionsFromDescriptors(
      getProviderOptionDescriptors({
        caps: fusionCaps,
        selections: [
          { id: "lead", value: "luna" },
          { id: "effort", value: "low" },
          { id: "sidekick", value: "glm-priority" },
          { id: "fastMode", value: false },
        ],
      }),
      [
        { id: "lead", value: "luna" },
        { id: "effort", value: "low" },
        { id: "sidekick", value: "glm-priority" },
        { id: "fastMode", value: false },
        // Stale UID from an earlier session: contradicts the explicit picks.
        { id: "__providerVariant", value: "fusion-opus-high-sidekick-swe-2" },
      ],
      fusionCaps,
    );
    expect(normalized?.find((s) => s.id === "__providerVariant")?.value).toBe(
      "fusion-luna-low-sidekick-glm-priority",
    );
  });

  it("emits the resolved variant even with no explicit selections", () => {
    const descriptors = getProviderOptionDescriptors({ caps: fusionCaps });
    expect(
      buildExplicitProviderOptionSelectionsFromDescriptors(descriptors, [], fusionCaps),
    ).toEqual([
      { id: "lead", value: "opus" },
      { id: "effort", value: "high" },
      { id: "sidekick", value: "swe-2" },
      { id: "fastMode", value: false },
      { id: "__providerVariant", value: "fusion-opus-high-sidekick-swe-2" },
    ]);
  });

  it("filters select options to values compatible with the current pairing", () => {
    const descriptors = getProviderOptionDescriptors({
      caps: fusionCaps,
      selections: [
        { id: "lead", value: "opus" },
        { id: "effort", value: "high" },
        { id: "sidekick", value: "swe-2" },
        { id: "fastMode", value: false },
      ],
    });
    const sidekick = descriptors.find((descriptor) => descriptor.id === "sidekick");
    // With opus+high+slow, swe-2-medium is unreachable; the other two stay.
    expect(sidekick?.type === "select" ? sidekick.options.map((o) => o.id) : []).toEqual([
      "swe-2",
      "swe-2-high",
    ]);
    // A select whose compatible set is a singleton keeps all advertised
    // choices — narrowing it would lock the only pivot control.
    const lead = descriptors.find((descriptor) => descriptor.id === "lead");
    expect(lead?.type === "select" ? lead.options.map((o) => o.id) : []).toEqual(["opus", "luna"]);
    expect(
      getCompatibleProviderOptionValues({
        caps: fusionCaps,
        selections: [
          { id: "lead", value: "opus" },
          { id: "effort", value: "high" },
          { id: "fastMode", value: true },
        ],
        descriptorId: "sidekick",
      }),
    ).toEqual(new Set(["swe-2-medium"]));
  });

  it("passes selections through untouched when no variant table exists", () => {
    const selections = [{ id: "reasoningEffort", value: "high" }];
    expect(normalizeProviderOptionSelections({ caps: codexCaps, selections })).toEqual(selections);
    expect(
      getCompatibleProviderOptionValues({
        caps: codexCaps,
        selections,
        descriptorId: "reasoningEffort",
      }),
    ).toBeUndefined();
  });
});

describe("model slug normalization", () => {
  it("preserves exact custom slugs instead of expanding provider aliases", () => {
    const cursor = ProviderDriverKind.make("cursor");

    expect(normalizeModelSlug("opus-4.6", cursor)).toBe("claude-opus-4-6");
    expect(normalizeCustomModelSlug(" opus-4.6 ")).toBe("opus-4.6");
  });
});

describe("input capabilities", () => {
  it("omits capability fields when no modality is disabled", () => {
    const caps = createModelCapabilities({ optionDescriptors: [] });
    expect(caps.inputImages).toBeUndefined();
    expect(caps.inputAudio).toBeUndefined();
    expect(caps.inputFiles).toBeUndefined();
  });

  it("only records modalities that are explicitly disabled", () => {
    const caps = createModelCapabilities({
      optionDescriptors: [],
      inputImages: false,
      inputAudio: false,
    });
    expect(caps.inputImages).toBe(false);
    expect(caps.inputAudio).toBe(false);
    expect(caps.inputFiles).toBeUndefined();
  });

  it("ignores explicit true so the wire shape stays minimal", () => {
    const caps = createModelCapabilities({
      optionDescriptors: [],
      inputImages: true,
      inputFiles: true,
    });
    expect(caps.inputImages).toBeUndefined();
    expect(caps.inputFiles).toBeUndefined();
  });

  it("resolves absent fields to supported", () => {
    expect(getModelInputCapabilities(undefined)).toEqual({
      images: true,
      audio: true,
      files: true,
    });
    expect(getModelInputCapabilities({ optionDescriptors: [] })).toEqual({
      images: true,
      audio: true,
      files: true,
    });
  });

  it("resolves explicitly disabled fields to false", () => {
    expect(
      getModelInputCapabilities({
        optionDescriptors: [],
        inputImages: false,
        inputAudio: false,
      }),
    ).toEqual({ images: false, audio: false, files: true });
  });
});

describe("applyClaudePromptEffortPrefix", () => {
  it("keeps slash commands intact when ultrathink is selected", () => {
    expect(applyClaudePromptEffortPrefix("/compact", "ultrathink")).toBe("/compact");
    expect(applyClaudePromptEffortPrefix(" /compact keep recent errors ", "ultrathink")).toBe(
      "/compact keep recent errors",
    );
    expect(applyClaudePromptEffortPrefix(" /review src/model.ts ", "ultrathink")).toBe(
      "/review src/model.ts",
    );
    expect(applyClaudePromptEffortPrefix("/security-review", "ultrathink")).toBe(
      "/security-review",
    );
    expect(applyClaudePromptEffortPrefix("/plugin:skill run", "ultrathink")).toBe(
      "/plugin:skill run",
    );
    expect(applyClaudePromptEffortPrefix("/deploy.prod to staging", "ultrathink")).toBe(
      "/deploy.prod to staging",
    );
  });

  it("still adds the ultrathink prefix to ordinary prompts", () => {
    expect(applyClaudePromptEffortPrefix("Investigate this failure", "ultrathink")).toBe(
      "Ultrathink:\nInvestigate this failure",
    );
    expect(applyClaudePromptEffortPrefix("/home/theo/app.ts crashed on load", "ultrathink")).toBe(
      "Ultrathink:\n/home/theo/app.ts crashed on load",
    );
  });
});

describe("readCustomModelEntries", () => {
  const capabilities: ModelCapabilities = {
    optionDescriptors: [
      {
        id: "effort",
        label: "Reasoning",
        type: "select",
        options: [{ id: "high", label: "High", isDefault: true }],
        currentValue: "high",
      },
    ],
  };

  it("resolves bare slugs and entries, trimming and deduplicating on slug", () => {
    expect(
      readCustomModelEntries([
        " bare ",
        { slug: "named", name: " Named ", capabilities },
        "bare",
        { slug: "named", name: "Second" },
        "",
        { name: "no slug" },
        42,
      ]),
    ).toEqual([
      { slug: "bare", name: "bare", capabilities: null },
      { slug: "named", name: "Named", capabilities },
    ]);
  });

  it("drops unparseable capabilities but keeps the entry", () => {
    expect(
      readCustomModelEntries([{ slug: "x", capabilities: { optionDescriptors: "nope" } }]),
    ).toEqual([{ slug: "x", name: "x", capabilities: null }]);
    expect(readCustomModelEntries("not a list")).toEqual([]);
  });

  it("writes the compact stored shape back", () => {
    expect(toCustomModelSetting({ slug: "x", name: "x", capabilities: null })).toBe("x");
    expect(
      toCustomModelSetting({ slug: "x", name: "x", capabilities: { optionDescriptors: [] } }),
    ).toBe("x");
    expect(toCustomModelSetting({ slug: "x", name: "X", capabilities })).toEqual({
      slug: "x",
      name: "X",
      capabilities,
    });
  });
});
