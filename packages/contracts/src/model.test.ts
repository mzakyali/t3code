import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";
import { ModelCapabilities } from "./model.ts";

const decodeCapabilities = Schema.decodeUnknownSync(ModelCapabilities);

it("decodes provider option variants without changing ordinary descriptors", () => {
  const result = decodeCapabilities({
    optionDescriptors: [
      {
        id: "fusionLead",
        label: "Lead",
        type: "select",
        options: [{ id: "lead-a", label: "Lead A", isDefault: true }],
      },
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
    ],
  });

  expect(result.optionVariants).toEqual([
    expect.objectContaining({
      model: "fusion-lead-a-medium-sidekick-swe-2-medium",
    }),
  ]);
});

it("rejects an option variant with an empty concrete model id", () => {
  expect(() =>
    decodeCapabilities({
      optionVariants: [{ model: "   ", selections: [] }],
    }),
  ).toThrow();
});
