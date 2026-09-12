import { describe, expect, it } from "vite-plus/test";

import {
  buildDevinModelsFromPayload,
  inferDevinContextWindowTokens,
  parseDevinFusionModelUid,
  parseDevinHumanModelList,
  parseDevinModelUid,
} from "./DevinProvider.ts";

describe("buildDevinModelsFromPayload", () => {
  it("maps families, marks adaptive as default, and removes duplicate ids", () => {
    const models = buildDevinModelsFromPayload({
      families: [
        {
          family_label: "Devin",
          family_uid: "devin",
          variants: [
            { model_uid: "adaptive", label: "Adaptive" },
            { model_uid: "claude-sonnet-4-6", label: "Claude Sonnet 4.6" },
          ],
        },
        {
          family_label: "Duplicate",
          family_uid: "duplicate",
          variants: [{ model_uid: "adaptive", label: "Adaptive again" }],
        },
      ],
    });

    expect(
      models.map(({ slug, name, subProvider, isDefault }) => ({
        slug,
        name,
        subProvider,
        isDefault,
      })),
    ).toEqual([
      { slug: "adaptive", name: "Adaptive", subProvider: "Devin", isDefault: true },
      {
        slug: "claude-sonnet-4-6",
        name: "Claude Sonnet 4.6",
        subProvider: "Devin",
        isDefault: undefined,
      },
    ]);
  });

  it("populates per-model input capabilities from the known mapping", () => {
    const models = buildDevinModelsFromPayload({
      families: [
        {
          family_label: "Devin",
          family_uid: "devin",
          variants: [
            { model_uid: "adaptive", label: "Adaptive" },
            { model_uid: "claude-sonnet-4-6", label: "Claude Sonnet 4.6" },
          ],
        },
      ],
    });

    const adaptive = models.find((model) => model.slug === "adaptive");
    // Devin models accept images and files but not audio.
    expect(adaptive?.capabilities?.inputImages).not.toBe(false);
    expect(adaptive?.capabilities?.inputFiles).not.toBe(false);
    expect(adaptive?.capabilities?.inputAudio).toBe(false);

    // An unmapped slug keeps the permissive default (no capability fields set).
    const unmapped = models.find((model) => model.slug === "claude-sonnet-4-6");
    expect(unmapped?.capabilities?.inputImages).toBeUndefined();
    expect(unmapped?.capabilities?.inputAudio).toBeUndefined();
    expect(unmapped?.capabilities?.inputFiles).toBeUndefined();
  });

  it("groups reasoning variants into one model with a reasoning option descriptor", () => {
    const models = buildDevinModelsFromPayload({
      families: [
        {
          family_label: "Claude Opus 5",
          family_uid: "claude-opus-5",
          variants: [
            { model_uid: "claude-opus-5-low", label: "Claude Opus 5 Low" },
            { model_uid: "claude-opus-5-medium", label: "Claude Opus 5 Medium" },
            { model_uid: "claude-opus-5-high", label: "Claude Opus 5 High" },
          ],
        },
      ],
    });

    expect(models.map((m) => m.slug)).toEqual(["claude-opus-5"]);
    const grouped = models[0]!;
    expect(grouped.name).toBe("Claude Opus 5");
    const descriptor = grouped.capabilities?.optionDescriptors?.[0];
    expect(descriptor?.type).toBe("select");
    expect(descriptor?.id).toBe("reasoning");
    const options = descriptor?.type === "select" ? descriptor.options : undefined;
    expect(options?.map((o) => ({ id: o.id, label: o.label, isDefault: o.isDefault }))).toEqual([
      { id: "low", label: "Low", isDefault: undefined },
      { id: "medium", label: "Medium", isDefault: true },
      { id: "high", label: "High", isDefault: undefined },
    ]);
  });

  it("groups speed-tier variants into one model with a speed option", () => {
    const models = buildDevinModelsFromPayload({
      families: [
        {
          family_label: "Claude Opus 5",
          family_uid: "claude-opus-5",
          variants: [
            { model_uid: "claude-opus-5-medium", label: "Claude Opus 5 Medium" },
            { model_uid: "claude-opus-5-low", label: "Claude Opus 5 Low" },
            { model_uid: "claude-opus-5-medium-fast", label: "Claude Opus 5 Medium Fast" },
            { model_uid: "claude-opus-5-low-fast", label: "Claude Opus 5 Low Fast" },
          ],
        },
      ],
    });

    const slugs = models.map((m) => m.slug);
    expect(slugs).toEqual(["claude-opus-5"]);
    const descriptors = models[0]!.capabilities?.optionDescriptors ?? [];
    const speedDescriptor = descriptors.find((d) => d.id === "speed");
    expect(speedDescriptor?.type).toBe("select");
    expect(
      speedDescriptor?.type === "select" ? speedDescriptor.options.map((o) => o.id) : [],
    ).toEqual(["standard", "fast"]);
  });

  it("groups uppercase enum-style variants and defaults to medium", () => {
    const models = buildDevinModelsFromPayload({
      families: [
        {
          family_label: "GPT 5.2",
          family_uid: "gpt-5-2",
          variants: [
            { model_uid: "MODEL_GPT_5_2_LOW", label: "GPT 5.2 Low" },
            { model_uid: "MODEL_GPT_5_2_MEDIUM", label: "GPT 5.2 Medium" },
            { model_uid: "MODEL_GPT_5_2_HIGH", label: "GPT 5.2 High" },
          ],
        },
      ],
    });

    expect(models.map((m) => m.slug)).toEqual(["MODEL_GPT_5_2"]);
    const upperDescriptor = models[0]!.capabilities?.optionDescriptors?.[0];
    const upperOptions = upperDescriptor?.type === "select" ? upperDescriptor.options : undefined;
    expect(upperOptions?.find((o) => o.id === "medium")?.isDefault).toBe(true);
  });

  it("keeps GLM reasoning limited to none, high, and max across context windows", () => {
    const models = buildDevinModelsFromPayload({
      families: [
        {
          family_label: "GLM-5.2",
          family_uid: "glm-5.2",
          variants: [
            { model_uid: "glm-5-2", label: "GLM-5.2 High" },
            { model_uid: "glm-5-2-max", label: "GLM-5.2 Max" },
            { model_uid: "glm-5-2-1m", label: "GLM-5.2 High 1M" },
            { model_uid: "glm-5-2-max-1m", label: "GLM-5.2 Max 1M" },
            { model_uid: "glm-5-2-none", label: "GLM-5.2 No Thinking" },
            { model_uid: "glm-5-2-none-1m", label: "GLM-5.2 No Thinking 1M" },
          ],
        },
      ],
    });
    expect(models).toHaveLength(1);
    expect(models[0]?.name).toBe("GLM-5.2");
    const descriptors = models[0]?.capabilities?.optionDescriptors ?? [];
    const reasoning = descriptors.find((descriptor) => descriptor.id === "reasoning");
    expect(
      reasoning?.type === "select" ? reasoning.options.map((option) => option.id) : [],
    ).toEqual(["none", "high", "max"]);
    expect(
      reasoning?.type === "select"
        ? reasoning.options.find((option) => option.isDefault)?.id
        : undefined,
    ).toBe("high");
    const context = descriptors.find((descriptor) => descriptor.id === "contextWindow");
    expect(context?.type === "select" ? context.options.map((option) => option.id) : []).toEqual([
      "200k",
      "1m",
    ]);
    expect(
      context?.type === "select"
        ? context.options.find((option) => option.isDefault)?.id
        : undefined,
    ).toBe("200k");
  });

  it("groups opaque private UIDs under their family and preserves concrete reasoning UIDs", () => {
    const models = buildDevinModelsFromPayload({
      families: [
        {
          family_label: "Claude Sonnet 4.5",
          family_uid: "claude-sonnet-4.5",
          variants: [
            { model_uid: "MODEL_PRIVATE_2", label: "Claude Sonnet 4.5" },
            { model_uid: "MODEL_PRIVATE_3", label: "Claude Sonnet 4.5 Thinking" },
          ],
        },
      ],
    });

    expect(models).toHaveLength(1);
    expect(models[0]?.slug).toBe("MODEL_PRIVATE_2");
    const reasoning = models[0]?.capabilities?.optionDescriptors?.find(
      (descriptor) => descriptor.id === "reasoning",
    );
    expect(reasoning?.type === "select" ? reasoning.options : []).toEqual([
      { id: "none", label: "None", isDefault: true },
      { id: "__uid:MODEL_PRIVATE_3", label: "Thinking" },
    ]);
  });

  it("leaves unrelated models without a reasoning suffix as standalone variants", () => {
    const models = buildDevinModelsFromPayload({
      families: [
        {
          family_label: "Misc",
          family_uid: "misc",
          variants: [
            { model_uid: "kimi-k2-6", label: "Kimi K2.6" },
            { model_uid: "claude-opus-4-6-1m", label: "Claude Opus 4.6 1M" },
          ],
        },
      ],
    });

    expect(models.map((m) => m.slug)).toEqual(["kimi-k2-6", "claude-opus-4-6-1m"]);
    for (const model of models) {
      expect(model.capabilities?.optionDescriptors).toEqual([]);
    }
  });

  it("keeps explicit context metadata when the JSON catalog omits UID suffixes", () => {
    const models = buildDevinModelsFromPayload({
      families: [
        {
          family_label: "GLM-5.2",
          family_uid: "glm-5.2",
          variants: [
            {
              model_uid: "glm-5-2",
              label: "GLM-5.2 High",
              context_window: 200_000,
              pricing: { inputPerMillion: 0, outputPerMillion: 0 },
            },
            {
              model_uid: "glm-5-2-1m",
              label: "GLM-5.2 High 1M",
              context_window: 1_000_000,
              pricing: { inputPerMillion: 0.7, outputPerMillion: 2.2 },
            },
            {
              model_uid: "glm-5-2-none",
              label: "GLM-5.2 No Thinking",
              context_window: 200_000,
              pricing: { inputPerMillion: 0.7, outputPerMillion: 2.2 },
            },
          ],
        },
      ],
    });

    const glm = models[0]!;
    const context = glm.capabilities?.optionDescriptors?.find(
      (descriptor) => descriptor.id === "contextWindow",
    );
    expect(context?.type === "select" ? context.options.map((option) => option.id) : []).toEqual([
      "200k",
      "1m",
    ]);
    expect(glm.contextWindowTokens).toBe(1_000_000);
    expect(glm.pricingByVariant?.["glm-5-2-1m"]?.outputPerMillion).toBe(2.2);
  });
});

describe("Devin model catalog fallbacks", () => {
  it("parses the human-readable CLI catalog with context and prices", () => {
    const payload = parseDevinHumanModelList(
      `Available models (1 families)\n\nGLM-5.2 (glm-5.2)\n  aliases: glm\n  glm-5-2                                GLM-5.2 High  [200K context, Free]\n  glm-5-2-max                            GLM-5.2 Max  [200K context, $0.7 / 1M Input · $0.13 / 1M Cached input · $2.2 / 1M Output]\n  glm-5-2-none-1m                        GLM-5.2 No Thinking 1M  [1M context, $0.7 / 1M Input · $0.13 / 1M Cached input · $2.2 / 1M Output]`,
    );

    expect(payload?.families).toHaveLength(1);
    expect(payload?.families[0]?.variants).toHaveLength(3);
    expect(payload?.families[0]?.variants[1]?.contextWindow).toBe(200_000);
    const variantPricing = payload?.families[0]?.variants[1]?.pricing as
      | { outputPerMillion?: number }
      | undefined;
    expect(variantPricing?.outputPerMillion).toBe(2.2);

    const glm = buildDevinModelsFromPayload(payload!)[0]!;
    expect(glm.slug).toBe("glm-5-2");
    expect(glm.pricingByVariant?.["glm-5-2-max"]?.cachedInputPerMillion).toBe(0.13);
    expect(glm.contextWindowTokens).toBe(1_000_000);
  });

  it("infers known Devin context limits from family and variant UIDs", () => {
    expect(inferDevinContextWindowTokens("glm-5-2-max")).toBe(200_000);
    expect(inferDevinContextWindowTokens("glm-5-2-max-1m")).toBe(1_000_000);
    expect(inferDevinContextWindowTokens("MODEL_GPT_5_2_HIGH")).toBe(384_000);
    expect(inferDevinContextWindowTokens("unknown-model")).toBeUndefined();
  });
});

describe("parseDevinModelUid", () => {
  it("extracts reasoning and speed from lowercase hyphenated UIDs", () => {
    expect(parseDevinModelUid("claude-opus-5-medium")).toEqual({
      base: "claude-opus-5",
      reasoning: "medium",
      speed: undefined,
      contextWindow: undefined,
    });
    expect(parseDevinModelUid("claude-opus-5-medium-fast")).toEqual({
      base: "claude-opus-5",
      reasoning: "medium",
      speed: "fast",
      contextWindow: undefined,
    });
  });

  it("extracts reasoning from uppercase underscore UIDs", () => {
    expect(parseDevinModelUid("MODEL_GPT_5_2_LOW")).toEqual({
      base: "MODEL_GPT_5_2",
      reasoning: "low",
      speed: undefined,
      contextWindow: undefined,
    });
  });

  it("extracts context window suffixes", () => {
    expect(parseDevinModelUid("glm-5-2-max-1m")).toEqual({
      base: "glm-5-2",
      reasoning: "max",
      speed: undefined,
      contextWindow: "1m",
    });
  });

  it("returns no reasoning for UIDs without a known suffix", () => {
    expect(parseDevinModelUid("kimi-k2-6")).toEqual({
      base: "kimi-k2-6",
      reasoning: undefined,
      speed: undefined,
      contextWindow: undefined,
    });
    expect(parseDevinModelUid("claude-opus-4-6-thinking")).toEqual({
      base: "claude-opus-4-6",
      reasoning: "thinking",
      speed: undefined,
      contextWindow: undefined,
    });
  });

  it("does not treat a bare speed suffix as a speed tier without reasoning", () => {
    expect(parseDevinModelUid("claude-opus-5-fast")).toEqual({
      base: "claude-opus-5-fast",
      reasoning: undefined,
      speed: undefined,
    });
  });
});

describe("parseDevinFusionModelUid", () => {
  it("parses lead, effort, sidekick variant, and standard mode", () => {
    expect(parseDevinFusionModelUid("fusion-claude-fable-5-1-high-sidekick-swe-2-medium")).toEqual({
      leadModel: "claude-fable-5-1",
      leadEffort: "high",
      sidekick: "swe-2-medium",
      fastMode: false,
    });
  });

  it("parses Fast Mode from the lead fast marker and sidekick priority marker", () => {
    expect(
      parseDevinFusionModelUid("fusion-gpt-5-6-sol-high-fast-sidekick-swe-2-medium")?.fastMode,
    ).toBe(true);
    expect(
      parseDevinFusionModelUid(
        "fusion-claude-fable-5-1-medium-fast-sidekick-gpt-5-6-luna-high-priority",
      ),
    ).toEqual({
      leadModel: "claude-fable-5-1",
      leadEffort: "medium",
      sidekick: "gpt-5-6-luna-high",
      fastMode: true,
    });
  });

  it("rejects UIDs outside the Fusion grammar", () => {
    expect(parseDevinFusionModelUid("claude-opus-5-medium")).toBeNull();
    expect(parseDevinFusionModelUid("fusion-claude-fable-5-1")).toBeNull();
    expect(parseDevinFusionModelUid("fusion-claude-fable-5-1-sidekick-swe-2-medium")).toBeNull();
    expect(
      parseDevinFusionModelUid("fusion-claude-fable-5-1-ultra-sidekick-swe-2-medium"),
    ).toBeNull();
    expect(parseDevinFusionModelUid("fusion-claude-fable-5-1-high-sidekick-")).toBeNull();
    expect(parseDevinFusionModelUid("fusion--sidekick-swe-2-medium")).toBeNull();
  });
});

describe("Devin Fusion catalog", () => {
  const fusionFamily = {
    family_label: "Fusion",
    family_uid: "fusion",
    variants: [
      {
        model_uid: "fusion-claude-fable-5-1-high-sidekick-swe-2-medium",
        label: "Fable 5.1 High + SWE-2 Medium",
      },
      {
        model_uid: "fusion-gpt-5-6-sol-high-fast-sidekick-swe-2-medium",
        label: "GPT Sol High Fast + SWE-2 Medium",
      },
    ],
  };

  it("emits one Fusion model with exact valid variants", () => {
    const models = buildDevinModelsFromPayload({
      families: [fusionFamily],
    });

    expect(models).toHaveLength(1);
    expect(models[0]?.slug).toBe("fusion");
    expect(models[0]?.capabilities?.optionVariants).toHaveLength(2);
    expect(models[0]?.capabilities?.optionDescriptors?.map((descriptor) => descriptor.id)).toEqual([
      "fusionLead",
      "fusionEffort",
      "fusionSidekick",
      "fastMode",
    ]);
  });

  it("emits Fusion descriptors and variant selections keyed by exact UID", () => {
    const models = buildDevinModelsFromPayload({
      families: [fusionFamily],
    });

    const fusion = models[0]!;
    expect(fusion.name).toBe("Fusion");
    expect(fusion.subProvider).toBe("Fusion");
    expect(fusion.capabilities?.inputAudio).toBe(false);

    const descriptors = fusion.capabilities?.optionDescriptors ?? [];
    expect(descriptors.map((descriptor) => descriptor.type)).toEqual([
      "select",
      "select",
      "select",
      "boolean",
    ]);
    expect(descriptors.some((descriptor) => descriptor.id === "reasoning")).toBe(false);
    expect(descriptors.some((descriptor) => descriptor.id === "speed")).toBe(false);

    expect(fusion.capabilities?.optionVariants).toEqual([
      {
        model: "fusion-claude-fable-5-1-high-sidekick-swe-2-medium",
        selections: [
          { id: "fusionLead", value: "claude-fable-5-1" },
          { id: "fusionEffort", value: "high" },
          { id: "fusionSidekick", value: "swe-2-medium" },
          { id: "fastMode", value: false },
        ],
      },
      {
        model: "fusion-gpt-5-6-sol-high-fast-sidekick-swe-2-medium",
        selections: [
          { id: "fusionLead", value: "gpt-5-6-sol" },
          { id: "fusionEffort", value: "high" },
          { id: "fusionSidekick", value: "swe-2-medium" },
          { id: "fastMode", value: true },
        ],
      },
    ]);
  });

  it("marks the first catalog row's values as the descriptor defaults", () => {
    const models = buildDevinModelsFromPayload({
      families: [fusionFamily],
    });

    const descriptors = models[0]?.capabilities?.optionDescriptors ?? [];
    const defaultFor = (id: string) => {
      const descriptor = descriptors.find((candidate) => candidate.id === id);
      if (descriptor?.type === "boolean") return descriptor.currentValue;
      if (descriptor?.type === "select") {
        return descriptor.options.find((option) => option.isDefault)?.id;
      }
      return undefined;
    };
    expect(defaultFor("fusionLead")).toBe("claude-fable-5-1");
    expect(defaultFor("fusionEffort")).toBe("high");
    expect(defaultFor("fusionSidekick")).toBe("swe-2-medium");
    expect(defaultFor("fastMode")).toBe(false);
  });

  it("skips malformed Fusion records without dropping valid pairings", () => {
    const models = buildDevinModelsFromPayload({
      families: [
        {
          family_label: "Fusion",
          family_uid: "fusion",
          variants: [
            {
              model_uid: "fusion-claude-fable-5-1-high-sidekick-swe-2-medium",
              label: "Fable 5.1 High + SWE-2 Medium",
            },
            {
              model_uid: "fusion-claude-fable-5-1-ultra-sidekick-swe-2-medium",
              label: "Fable 5.1 Ultra + SWE-2 Medium",
            },
            { model_uid: "fusion-missing-boundary", label: "Broken" },
            { model_uid: "claude-opus-5-medium", label: "Not a Fusion UID" },
            {
              model_uid: "fusion-claude-fable-5-1-high-sidekick-swe-2-medium",
              label: "Duplicate row",
            },
          ],
        },
      ],
    });

    expect(models).toHaveLength(1);
    expect(models[0]?.slug).toBe("fusion");
    expect(models[0]?.capabilities?.optionVariants?.map((variant) => variant.model)).toEqual([
      "fusion-claude-fable-5-1-high-sidekick-swe-2-medium",
    ]);
  });

  it("omits the Fusion row when every record is malformed", () => {
    const models = buildDevinModelsFromPayload({
      families: [
        {
          family_label: "Fusion",
          family_uid: "fusion",
          variants: [{ model_uid: "fusion-no-effort-sidekick-swe-2", label: "Broken" }],
        },
      ],
    });

    expect(models).toHaveLength(0);
  });

  it("keeps ordinary Devin families on the generic path alongside Fusion", () => {
    const models = buildDevinModelsFromPayload({
      families: [
        fusionFamily,
        {
          family_label: "GLM-5.2",
          family_uid: "glm-5.2",
          variants: [
            {
              model_uid: "glm-5-2",
              label: "GLM-5.2 High",
              context_window: 200_000,
              pricing: { inputPerMillion: 0, outputPerMillion: 0 },
            },
            {
              model_uid: "glm-5-2-1m",
              label: "GLM-5.2 High 1M",
              context_window: 1_000_000,
              pricing: { inputPerMillion: 0.7, outputPerMillion: 2.2 },
            },
          ],
        },
      ],
    });

    expect(models.map((model) => model.slug)).toEqual(["fusion", "glm-5-2"]);
    const glm = models[1]!;
    expect(glm.name).toBe("GLM-5.2");
    expect(glm.capabilities?.optionDescriptors?.map((descriptor) => descriptor.id)).toContain(
      "reasoning",
    );
    expect(glm.contextWindowTokens).toBe(1_000_000);
    expect(glm.pricingByVariant?.["glm-5-2-1m"]?.outputPerMillion).toBe(2.2);
  });
});
