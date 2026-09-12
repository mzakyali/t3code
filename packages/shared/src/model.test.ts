import { describe, expect, it } from "vite-plus/test";
import { ProviderDriverKind, ProviderInstanceId, type ModelCapabilities } from "@t3tools/contracts";

import {
  applyClaudePromptEffortPrefix,
  buildExplicitProviderOptionSelectionsFromDescriptors,
  buildProviderOptionSelectionsForModel,
  buildProviderOptionSelectionsFromDescriptors,
  createModelCapabilities,
  createModelSelection,
  getModelInputCapabilities,
  getModelSelectionBooleanOptionValue,
  getModelSelectionStringOptionValue,
  getProviderOptionDescriptors,
  readCustomModelEntries,
  toCustomModelSetting,
  getProviderOptionBooleanSelectionValue,
  getProviderOptionStringSelectionValue,
  normalizeCustomModelSlug,
  normalizeModelSlug,
  normalizeProviderOptionSelections,
  PROVIDER_OPTION_VARIANT_SELECTION_ID,
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

describe("variant-constrained options", () => {
  const fusionCaps = createModelCapabilities({
    optionDescriptors: [
      {
        id: "fusionLead",
        label: "Lead",
        type: "select",
        options: [
          { id: "lead-a", label: "Lead A", isDefault: true },
          { id: "lead-b", label: "Lead B" },
        ],
      },
      {
        id: "fusionEffort",
        label: "Effort",
        type: "select",
        options: [
          { id: "medium", label: "Medium", isDefault: true },
          { id: "high", label: "High" },
        ],
      },
      {
        id: "fusionSidekick",
        label: "Sidekick",
        type: "select",
        options: [
          { id: "swe-2-medium", label: "SWE-2 Medium", isDefault: true },
          { id: "glm-5-2", label: "GLM-5.2" },
        ],
      },
      { id: "fastMode", label: "Fast Mode", type: "boolean", currentValue: false },
    ],
    optionVariants: [
      {
        model: "fusion-lead-a-medium-sidekick-swe-2-medium",
        selections: [
          { id: "fusionLead", value: "lead-a" },
          { id: "fusionEffort", value: "medium" },
          { id: "fusionSidekick", value: "swe-2-medium" },
          { id: "fastMode", value: false },
        ],
      },
      {
        model: "fusion-lead-b-high-fast-sidekick-glm-5-2",
        selections: [
          { id: "fusionLead", value: "lead-b" },
          { id: "fusionEffort", value: "high" },
          { id: "fusionSidekick", value: "glm-5-2" },
          { id: "fastMode", value: true },
        ],
      },
    ],
  });

  it("filters choices and retains the exact selected variant", () => {
    const descriptors = getProviderOptionDescriptors({ caps: fusionCaps });
    const next = descriptors.map((descriptor) =>
      descriptor.id === "fusionLead" && descriptor.type === "select"
        ? { ...descriptor, currentValue: "lead-b" }
        : descriptor,
    );
    const selections = buildProviderOptionSelectionsForModel({
      caps: fusionCaps,
      descriptors: next,
    });

    expect(selections).toEqual([
      { id: "fusionLead", value: "lead-b" },
      { id: "fusionEffort", value: "high" },
      { id: "fusionSidekick", value: "glm-5-2" },
      { id: "fastMode", value: true },
      { id: "__providerVariant", value: "fusion-lead-b-high-fast-sidekick-glm-5-2" },
    ]);
  });

  it("uses a deterministic valid variant for stale visible values", () => {
    const normalized = normalizeProviderOptionSelections({
      caps: fusionCaps,
      selections: [
        { id: "fusionLead", value: "missing-lead" },
        { id: "__providerVariant", value: "fusion-no-longer-in-catalog" },
      ],
    });

    expect(normalized?.at(-1)).toEqual({
      id: "__providerVariant",
      value: "fusion-lead-a-medium-sidekick-swe-2-medium",
    });
  });

  it("keeps independent options unchanged when no variants exist", () => {
    const descriptors = getProviderOptionDescriptors({
      caps: codexCaps,
      selections: [
        { id: "reasoningEffort", value: "high" },
        { id: "fastMode", value: true },
      ],
    });

    expect(buildProviderOptionSelectionsForModel({ caps: codexCaps, descriptors })).toEqual(
      buildProviderOptionSelectionsFromDescriptors(descriptors),
    );
    expect(
      normalizeProviderOptionSelections({
        caps: codexCaps,
        selections: [
          { id: "reasoningEffort", value: "xhigh" },
          { id: "unrelatedProviderOption", value: "kept" },
        ],
      }),
    ).toEqual([
      { id: "reasoningEffort", value: "xhigh" },
      { id: "unrelatedProviderOption", value: "kept" },
    ]);
  });

  it("filters descriptor choices to compatible variants without exposing the internal id", () => {
    const descriptors = getProviderOptionDescriptors({ caps: fusionCaps });
    expect(
      descriptors.some((descriptor) => descriptor.id === PROVIDER_OPTION_VARIANT_SELECTION_ID),
    ).toBe(false);

    const lead = descriptors.find((descriptor) => descriptor.id === "fusionLead");
    if (lead?.type !== "select") throw new Error("expected a select descriptor");
    expect(lead.options).toEqual([{ id: "lead-a", label: "Lead A", isDefault: true }]);
    expect(lead.currentValue).toBe("lead-a");
    expect(descriptors.find((descriptor) => descriptor.id === "fastMode")?.currentValue).toBe(
      false,
    );

    const normalized = normalizeProviderOptionSelections({
      caps: fusionCaps,
      selections: [
        { id: "unrelatedProviderOption", value: "kept" },
        { id: "fusionLead", value: "lead-b" },
      ],
    });
    expect(normalized?.at(0)).toEqual({ id: "unrelatedProviderOption", value: "kept" });
    expect(normalized?.at(-1)).toEqual({
      id: PROVIDER_OPTION_VARIANT_SELECTION_ID,
      value: "fusion-lead-b-high-fast-sidekick-glm-5-2",
    });
  });

  it("preserves a revert to the catalog default over the stored variant", () => {
    const normalized = normalizeProviderOptionSelections({
      caps: fusionCaps,
      selections: [
        { id: "fusionLead", value: "lead-a" },
        { id: "fusionEffort", value: "high" },
        { id: "fusionSidekick", value: "glm-5-2" },
        { id: "fastMode", value: true },
        { id: "__providerVariant", value: "fusion-lead-b-high-fast-sidekick-glm-5-2" },
      ],
    });

    expect(normalized).toEqual([
      { id: "fusionLead", value: "lead-a" },
      { id: "fusionEffort", value: "medium" },
      { id: "fusionSidekick", value: "swe-2-medium" },
      { id: "fastMode", value: false },
      { id: "__providerVariant", value: "fusion-lead-a-medium-sidekick-swe-2-medium" },
    ]);
  });

  it("replaces a stored variant id whose visible selections diverged", () => {
    const normalized = normalizeProviderOptionSelections({
      caps: fusionCaps,
      selections: [
        { id: "fusionLead", value: "lead-a" },
        { id: "fusionEffort", value: "medium" },
        { id: "fusionSidekick", value: "swe-2-medium" },
        { id: "fastMode", value: false },
        { id: "__providerVariant", value: "fusion-lead-b-high-fast-sidekick-glm-5-2" },
      ],
    });

    expect(normalized?.at(-1)).toEqual({
      id: "__providerVariant",
      value: "fusion-lead-a-medium-sidekick-swe-2-medium",
    });
  });

  it("retains a stored variant id whose visible selections still match", () => {
    const normalized = normalizeProviderOptionSelections({
      caps: fusionCaps,
      selections: [
        { id: "fusionLead", value: "lead-b" },
        { id: "fusionEffort", value: "high" },
        { id: "fusionSidekick", value: "glm-5-2" },
        { id: "fastMode", value: true },
        { id: "__providerVariant", value: "fusion-lead-b-high-fast-sidekick-glm-5-2" },
      ],
    });

    expect(normalized).toEqual([
      { id: "fusionLead", value: "lead-b" },
      { id: "fusionEffort", value: "high" },
      { id: "fusionSidekick", value: "glm-5-2" },
      { id: "fastMode", value: true },
      { id: "__providerVariant", value: "fusion-lead-b-high-fast-sidekick-glm-5-2" },
    ]);
  });

  it("emits only explicit selections while retaining the internal variant id", () => {
    const descriptors = getProviderOptionDescriptors({ caps: fusionCaps }).map((descriptor) =>
      descriptor.id === "fusionLead" && descriptor.type === "select"
        ? { ...descriptor, currentValue: "lead-b" }
        : descriptor,
    );

    const selections = buildProviderOptionSelectionsForModel({
      caps: fusionCaps,
      descriptors,
      explicitSelections: [{ id: "fusionLead", value: "lead-b" }],
    });

    expect(selections).toEqual([
      { id: "fusionLead", value: "lead-b" },
      { id: "__providerVariant", value: "fusion-lead-b-high-fast-sidekick-glm-5-2" },
    ]);
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
