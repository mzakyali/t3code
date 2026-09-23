import { describe, expect, it } from "vite-plus/test";

import type { ModelCapabilities } from "@t3tools/contracts";

import { applyProviderOptionSelection, resolveProviderOptionDescriptors } from "./providerOptions";

const CODEX_CAPABILITIES: ModelCapabilities = {
  optionDescriptors: [
    {
      id: "reasoningEffort",
      label: "Reasoning",
      type: "select",
      options: [
        { id: "medium", label: "Medium", isDefault: true },
        { id: "high", label: "High" },
      ],
      currentValue: "medium",
    },
    {
      id: "serviceTier",
      label: "Service Tier",
      type: "select",
      options: [
        { id: "default", label: "Standard", isDefault: true },
        { id: "priority", label: "Fast" },
      ],
      currentValue: "default",
    },
  ],
};

describe("mobile provider options", () => {
  it("updates generic select options without knowing provider-specific ids", () => {
    const descriptors = resolveProviderOptionDescriptors({
      capabilities: CODEX_CAPABILITIES,
      selections: undefined,
    });

    expect(
      applyProviderOptionSelection(descriptors, { id: "serviceTier", value: "priority" }),
    ).toEqual([
      { id: "reasoningEffort", value: "medium" },
      { id: "serviceTier", value: "priority" },
    ]);
    // Choices the model doesn't advertise are rejected, not stored.
    expect(
      applyProviderOptionSelection(descriptors, { id: "serviceTier", value: "turbo" }),
    ).toBeNull();
    expect(applyProviderOptionSelection(descriptors, { id: "unknown", value: "high" })).toBeNull();
  });

  it("updates generic boolean options", () => {
    const descriptors = resolveProviderOptionDescriptors({
      capabilities: {
        optionDescriptors: [{ id: "fastMode", label: "Fast Mode", type: "boolean" }],
      },
      selections: undefined,
    });

    expect(applyProviderOptionSelection(descriptors, { id: "fastMode", value: true })).toEqual([
      { id: "fastMode", value: true },
    ]);
  });

  it("normalizes dependent options around the changed control when a variant table exists", () => {
    const fusionCaps: ModelCapabilities = {
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
            { id: "glm-priority", label: "GLM Priority" },
          ],
          currentValue: "swe-2",
        },
      ],
      optionVariants: [
        {
          model: "fusion-opus-high-sidekick-swe-2",
          selections: [
            { id: "lead", value: "opus" },
            { id: "effort", value: "high" },
            { id: "sidekick", value: "swe-2" },
          ],
        },
        {
          model: "fusion-luna-low-sidekick-glm-priority",
          selections: [
            { id: "lead", value: "luna" },
            { id: "effort", value: "low" },
            { id: "sidekick", value: "glm-priority" },
          ],
        },
      ],
    };
    const descriptors = resolveProviderOptionDescriptors({
      capabilities: fusionCaps,
      selections: undefined,
    });

    // Switching the lead to luna forces effort+sidekick onto luna's only
    // valid pairing, and the exact dispatch UID is carried along.
    expect(
      applyProviderOptionSelection(descriptors, { id: "lead", value: "luna" }, fusionCaps),
    ).toEqual([
      { id: "lead", value: "luna" },
      { id: "effort", value: "low" },
      { id: "sidekick", value: "glm-priority" },
      { id: "__providerVariant", value: "fusion-luna-low-sidekick-glm-priority" },
    ]);

    // Without capabilities the descriptors' raw values pass through.
    expect(applyProviderOptionSelection(descriptors, { id: "lead", value: "luna" })).toEqual([
      { id: "lead", value: "luna" },
      { id: "effort", value: "high" },
      { id: "sidekick", value: "swe-2" },
    ]);
  });
});
