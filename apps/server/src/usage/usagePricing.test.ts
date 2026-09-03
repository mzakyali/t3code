import { describe, expect, it } from "@effect/vitest";

import {
  lookupRate,
  normalizeModelName,
  parseProviderModelRateTable,
  parseRateTable,
} from "./usagePricing.ts";

const rate = (input: number, cacheRead?: number) => ({
  input_cost_per_token: input,
  output_cost_per_token: input * 5,
  ...(cacheRead === undefined ? {} : { cache_read_input_token_cost: cacheRead }),
});

describe("usage pricing", () => {
  it("keeps the existing model-name normalization contract", () => {
    expect(normalizeModelName(" Anthropic/Claude-Opus-5 ")).toBe("claude-opus-5");
  });

  it("keeps the canonical Fable rate separate from DeepInfra in either order", () => {
    const canonical = ["claude-fable-5", rate(1e-5, 1e-6)] as const;
    const deepInfra = ["deepinfra/anthropic/claude-fable-5", rate(1e-5)] as const;

    for (const entries of [
      [canonical, deepInfra],
      [deepInfra, canonical],
    ]) {
      const table = parseRateTable(Object.fromEntries(entries));

      expect(lookupRate(table, "claude-fable-5")?.cacheReadCostPerToken).toBe(1e-6);
      expect(lookupRate(table, "deepinfra/anthropic/claude-fable-5")?.cacheReadCostPerToken).toBe(
        1e-5,
      );
      expect(lookupRate(table, "other/claude-fable-5")).toBeNull();
    }
  });

  it("prices a bracketed context-tier variant at the base model's rate", () => {
    const table = parseRateTable({ "claude-fable-5-1": rate(1e-5, 2.5e-7) });

    expect(lookupRate(table, "claude-fable-5-1[1m]")).toEqual(
      lookupRate(table, "claude-fable-5-1"),
    );
    expect(lookupRate(table, "anthropic/Claude-Fable-5-1[1m]")).toBeNull();
  });

  it("adds a bare alias when every qualified entry has the same rate", () => {
    const table = parseRateTable({
      "provider-a/example-model": rate(1),
      "provider-b/example-model": rate(1),
    });

    expect(lookupRate(table, "example-model")).toEqual(
      lookupRate(table, "provider-a/example-model"),
    );
  });

  it("leaves an ambiguous bare name unpriced", () => {
    const table = parseRateTable({
      "provider-a/example-model": rate(1),
      "provider-b/example-model": rate(3),
    });

    expect(lookupRate(table, "provider-a/example-model")?.inputCostPerToken).toBe(1);
    expect(lookupRate(table, "provider-b/example-model")?.inputCostPerToken).toBe(3);
    expect(lookupRate(table, "example-model")).toBeNull();
  });
});

describe("parseProviderModelRateTable", () => {
  it("reads standalone and grouped Devin pricing metadata", () => {
    const rates = parseProviderModelRateTable({
      models: [
        {
          slug: "adaptive",
          pricing: {
            inputPerMillion: 0.5,
            cachedInputPerMillion: 0.1,
            outputPerMillion: 2,
          },
        },
        {
          slug: "glm-5-2",
          pricingByVariant: {
            "glm-5-2": {
              inputPerMillion: 0.7,
              cachedInputPerMillion: 0.13,
              outputPerMillion: 2.2,
            },
          },
        },
      ],
    });

    expect(lookupRate(rates, "adaptive")).toMatchObject({
      inputCostPerToken: 0.5e-6,
      outputCostPerToken: 2e-6,
      cacheCreationCostPerToken: 0.5e-6,
    });
    expect(lookupRate(rates, "adaptive")?.cacheReadCostPerToken).toBeCloseTo(0.1e-6);
    expect(lookupRate(rates, "glm-5-2")).toMatchObject({
      inputCostPerToken: 0.7e-6,
      outputCostPerToken: 2.2e-6,
      cacheCreationCostPerToken: 0.7e-6,
    });
    expect(lookupRate(rates, "glm-5-2")?.cacheReadCostPerToken).toBeCloseTo(0.13e-6);
  });

  it("ignores malformed or incomplete pricing without crashing", () => {
    expect(
      parseProviderModelRateTable({
        models: [
          { slug: "missing-output", pricing: { inputPerMillion: 1 } },
          { slug: "negative", pricing: { inputPerMillion: -1, outputPerMillion: 2 } },
          { slug: "not-an-object", pricing: "free" },
        ],
      }).size,
    ).toBe(0);
    expect(parseProviderModelRateTable(null).size).toBe(0);
  });
});
