import { describe, expect, it } from "@effect/vitest";

import { lookupRate, parseProviderModelRateTable } from "./usagePricing.ts";

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
    expect(lookupRate(rates, "devin/glm-5-2")).toMatchObject({
      inputCostPerToken: 0.7e-6,
      outputCostPerToken: 2.2e-6,
      cacheCreationCostPerToken: 0.7e-6,
    });
    expect(lookupRate(rates, "devin/glm-5-2")?.cacheReadCostPerToken).toBeCloseTo(0.13e-6);
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
