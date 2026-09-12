import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { PROVIDER_OPTION_VARIANT_SELECTION_ID } from "@t3tools/shared/model";
import { describe, expect } from "vite-plus/test";

import {
  applyDevinAcpModelSelection,
  buildDevinAcpSpawnInput,
  resolveDevinAcpBaseModelId,
  resolveDevinModelUid,
} from "./DevinAcpSupport.ts";

const FUSION_UID = "fusion-claude-fable-5-1-high-sidekick-swe-2-medium";

describe("buildDevinAcpSpawnInput", () => {
  it("builds the default Devin ACP command", () => {
    expect(buildDevinAcpSpawnInput(undefined, "/tmp/project")).toEqual({
      command: "devin",
      args: ["acp"],
      cwd: "/tmp/project",
    });
  });

  it("uses a configured binary and environment", () => {
    expect(
      buildDevinAcpSpawnInput({ binaryPath: "/usr/local/bin/devin" }, "/tmp/project", {
        DEVIN_ORG: "example",
      }),
    ).toEqual({
      command: "/usr/local/bin/devin",
      args: ["acp"],
      cwd: "/tmp/project",
      env: { DEVIN_ORG: "example" },
    });
  });
});

describe("applyDevinAcpModelSelection", () => {
  it.effect("selects the requested model through ACP config", () => {
    const calls: string[] = [];
    return applyDevinAcpModelSelection({
      runtime: {
        setModel: (model) => Effect.sync(() => calls.push(model)).pipe(Effect.asVoid),
      },
      model: "claude-sonnet-4-6",
      mapError: ({ cause }) => cause,
    }).pipe(Effect.tap(() => Effect.sync(() => expect(calls).toEqual(["claude-sonnet-4-6"]))));
  });

  it.effect("folds a reasoning option into the full model UID", () => {
    const calls: string[] = [];
    return applyDevinAcpModelSelection({
      runtime: {
        setModel: (model) => Effect.sync(() => calls.push(model)).pipe(Effect.asVoid),
      },
      model: "claude-opus-5",
      selections: [{ id: "reasoning", value: "high" }],
      mapError: ({ cause }) => cause,
    }).pipe(Effect.tap(() => Effect.sync(() => expect(calls).toEqual(["claude-opus-5-high"]))));
  });

  it.effect("falls back to an unsuffixed no-thinking UID when a CLI uses that form", () => {
    const calls: string[] = [];
    return applyDevinAcpModelSelection({
      runtime: {
        setModel: (model) =>
          Effect.gen(function* () {
            calls.push(model);
            if (model.endsWith("-none")) {
              return yield* Effect.fail(new Error("unknown model") as never);
            }
          }),
      },
      model: "claude-opus-4-6",
      selections: [{ id: "reasoning", value: "none" }],
      mapError: ({ cause }) => cause,
    }).pipe(
      Effect.tap(() =>
        Effect.sync(() => expect(calls).toEqual(["claude-opus-4-6-none", "claude-opus-4-6"])),
      ),
    );
  });

  it.effect("applies the session's active Fusion UID when the selection omits the variant", () => {
    const calls: string[] = [];
    return applyDevinAcpModelSelection({
      runtime: {
        setModel: (model) => Effect.sync(() => calls.push(model)).pipe(Effect.asVoid),
      },
      model: "fusion",
      selections: [],
      fallbackModelUid: FUSION_UID,
      mapError: ({ cause }) => cause,
    }).pipe(Effect.tap(() => Effect.sync(() => expect(calls).toEqual([FUSION_UID]))));
  });

  it.effect("sends the exact Fusion variant UID to the model config option", () => {
    const calls: string[] = [];
    return applyDevinAcpModelSelection({
      runtime: {
        setModel: (model) => Effect.sync(() => calls.push(model)).pipe(Effect.asVoid),
      },
      model: "fusion",
      selections: [
        { id: "fusionLead", value: "claude-fable-5-1" },
        { id: "fusionSidekick", value: "swe-2-medium" },
        { id: PROVIDER_OPTION_VARIANT_SELECTION_ID, value: FUSION_UID },
      ],
      mapError: ({ cause }) => cause,
    }).pipe(Effect.tap(() => Effect.sync(() => expect(calls).toEqual([FUSION_UID]))));
  });

  it.effect("surfaces a rejected Fusion change without retrying another pairing", () => {
    const calls: string[] = [];
    return applyDevinAcpModelSelection({
      runtime: {
        setModel: (model) =>
          Effect.gen(function* () {
            calls.push(model);
            return yield* Effect.fail(new Error("unknown model") as never);
          }),
      },
      model: "fusion",
      selections: [
        { id: PROVIDER_OPTION_VARIANT_SELECTION_ID, value: FUSION_UID },
        // A none-style reasoning selection must not unlock a bare-family retry
        // that would silently run the turn under a different pairing.
        { id: "reasoning", value: "none" },
      ],
      mapError: ({ cause }) => cause,
    }).pipe(
      Effect.flip,
      Effect.tap(() => Effect.sync(() => expect(calls).toEqual([FUSION_UID]))),
    );
  });

  it("falls back to adaptive", () => {
    expect(resolveDevinAcpBaseModelId("  ")).toBe("adaptive");
  });
});

describe("resolveDevinModelUid", () => {
  it("combines a base slug with a reasoning option using a hyphen", () => {
    expect(resolveDevinModelUid("claude-opus-5", [{ id: "reasoning", value: "medium" }])).toBe(
      "claude-opus-5-medium",
    );
  });

  it("inserts the reasoning level before a speed tier", () => {
    expect(resolveDevinModelUid("claude-opus-5-fast", [{ id: "reasoning", value: "medium" }])).toBe(
      "claude-opus-5-medium-fast",
    );
  });

  it("combines reasoning, speed, and context options", () => {
    expect(
      resolveDevinModelUid("glm-5-2", [
        { id: "reasoning", value: "max" },
        { id: "speed", value: "priority" },
        { id: "contextWindow", value: "1m" },
      ]),
    ).toBe("glm-5-2-max-priority-1m");
  });

  it("uses GLM's unsuffixed UID for High", () => {
    expect(resolveDevinModelUid("glm-5-2", [{ id: "reasoning", value: "high" }])).toBe("glm-5-2");
    expect(
      resolveDevinModelUid("glm-5-2", [
        { id: "reasoning", value: "high" },
        { id: "contextWindow", value: "1m" },
      ]),
    ).toBe("glm-5-2-1m");
  });

  it("does not encode GLM's implicit 200K context in the UID", () => {
    expect(
      resolveDevinModelUid("glm-5-2", [
        { id: "reasoning", value: "max" },
        { id: "contextWindow", value: "200k" },
      ]),
    ).toBe("glm-5-2-max");
    expect(
      resolveDevinModelUid("glm-5-2", [
        { id: "reasoning", value: "none" },
        { id: "contextWindow", value: "200k" },
      ]),
    ).toBe("glm-5-2-none");
  });

  it("combines uppercase enum-style bases with an underscore and uppercased suffix", () => {
    expect(resolveDevinModelUid("MODEL_GPT_5_2", [{ id: "reasoning", value: "low" }])).toBe(
      "MODEL_GPT_5_2_LOW",
    );
  });

  it("accepts an explicit UID for opaque Devin reasoning variants", () => {
    expect(
      resolveDevinModelUid("MODEL_PRIVATE_2", [
        { id: "reasoning", value: "__uid:MODEL_PRIVATE_3" },
      ]),
    ).toBe("MODEL_PRIVATE_3");
  });

  it("returns the base slug when no reasoning option is provided", () => {
    expect(resolveDevinModelUid("claude-opus-5")).toBe("claude-opus-5");
    expect(resolveDevinModelUid("claude-opus-5-fast", [])).toBe("claude-opus-5-fast");
  });

  it("ignores a non-string reasoning value", () => {
    expect(resolveDevinModelUid("claude-opus-5", [{ id: "reasoning", value: true }])).toBe(
      "claude-opus-5",
    );
  });

  it("falls back to adaptive for empty input", () => {
    expect(resolveDevinModelUid("   ")).toBe("adaptive");
  });
});

describe("Fusion model UIDs", () => {
  it("routes the exact internal Fusion variant without generic suffix parsing", () => {
    expect(
      resolveDevinModelUid("fusion", [
        { id: "fusionLead", value: "claude-fable-5-1" },
        { id: "fusionEffort", value: "high" },
        { id: "fusionSidekick", value: "swe-2-medium" },
        { id: "fastMode", value: false },
        { id: PROVIDER_OPTION_VARIANT_SELECTION_ID, value: FUSION_UID },
      ]),
    ).toBe(FUSION_UID);
  });

  it("maps concrete Fusion UIDs to the stable session base", () => {
    expect(resolveDevinAcpBaseModelId(FUSION_UID)).toBe("fusion");
    expect(resolveDevinAcpBaseModelId("fusion")).toBe("fusion");
  });

  it("retains the active Fusion UID when an active client omits the internal selection", () => {
    expect(resolveDevinModelUid("fusion", [], FUSION_UID)).toBe(FUSION_UID);
  });

  it("accepts a concrete Fusion UID supplied as the model slug", () => {
    expect(resolveDevinModelUid(FUSION_UID)).toBe(FUSION_UID);
  });

  it("prefers the internal variant over a concrete model slug and the active UID", () => {
    expect(
      resolveDevinModelUid(
        "fusion-other-pairing",
        [{ id: PROVIDER_OPTION_VARIANT_SELECTION_ID, value: FUSION_UID }],
        "fusion-active-pairing",
      ),
    ).toBe(FUSION_UID);
  });

  it("trims whitespace around the internal variant UID", () => {
    expect(
      resolveDevinModelUid("fusion", [
        { id: PROVIDER_OPTION_VARIANT_SELECTION_ID, value: `  ${FUSION_UID}  ` },
      ]),
    ).toBe(FUSION_UID);
  });

  it("ignores variant values outside the Fusion family", () => {
    expect(
      resolveDevinModelUid("fusion", [
        { id: PROVIDER_OPTION_VARIANT_SELECTION_ID, value: "composer-2" },
      ]),
    ).toBe("fusion");
    expect(
      resolveDevinModelUid("fusion", [{ id: PROVIDER_OPTION_VARIANT_SELECTION_ID, value: true }]),
    ).toBe("fusion");
    expect(
      resolveDevinModelUid("fusion", [{ id: PROVIDER_OPTION_VARIANT_SELECTION_ID, value: "   " }]),
    ).toBe("fusion");
  });

  it("ignores a non-Fusion active UID and falls back to the family slug", () => {
    expect(resolveDevinModelUid("fusion", [], "claude-opus-5")).toBe("fusion");
    expect(resolveDevinModelUid("fusion")).toBe("fusion");
  });
});
