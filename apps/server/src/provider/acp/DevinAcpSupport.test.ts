import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import type * as EffectAcpSchema from "effect-acp/schema";
import { describe, expect } from "vite-plus/test";

import {
  applyDevinAcpModelSelection,
  buildDevinAcpSpawnInput,
  resolveDevinAcpBaseModelId,
  resolveDevinEffectiveModelUid,
  resolveDevinModelUid,
  resolveDevinSessionModelFallbacks,
} from "./DevinAcpSupport.ts";

const modelConfigOption = (values: ReadonlyArray<string>): EffectAcpSchema.SessionConfigOption => ({
  type: "select",
  id: "model",
  name: "Model",
  category: "model",
  currentValue: values[0] ?? "",
  options: values.map((value) => ({ value, name: value })),
});

const thoughtLevelConfigOption = (
  values: ReadonlyArray<string>,
  currentValue = values[0] ?? "",
): EffectAcpSchema.SessionConfigOption => ({
  type: "select",
  id: "thought_level",
  name: "Thought level",
  category: "thought_level",
  currentValue,
  options: values.map((value) => ({ value, name: value })),
});

const noConfigOptions = Effect.succeed([] as ReadonlyArray<EffectAcpSchema.SessionConfigOption>);

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

  it("passes a non-default agent type", () => {
    expect(buildDevinAcpSpawnInput({ agentType: "review" }, "/tmp/project").args).toEqual([
      "acp",
      "--agent-type",
      "review",
    ]);
    expect(buildDevinAcpSpawnInput({ agentType: "summarizer" }, "/tmp/project").args).toEqual([
      "acp",
      "--agent-type",
      "summarizer",
    ]);
  });

  it("omits the agent type flag for the default agent", () => {
    expect(buildDevinAcpSpawnInput({ agentType: "default" }, "/tmp/project").args).toEqual(["acp"]);
  });

  it("repeats --refusal-fallback per configured model", () => {
    expect(
      buildDevinAcpSpawnInput({ refusalFallback: "claude-opus-5, glm-5-2 ,,swe-2" }, "/tmp/project")
        .args,
    ).toEqual([
      "acp",
      "--refusal-fallback",
      "claude-opus-5",
      "--refusal-fallback",
      "glm-5-2",
      "--refusal-fallback",
      "swe-2",
    ]);
  });

  it("passes --cloud when Devin Cloud mode is enabled", () => {
    expect(buildDevinAcpSpawnInput({ cloud: true }, "/tmp/project").args).toEqual([
      "acp",
      "--cloud",
    ]);
    expect(buildDevinAcpSpawnInput({ cloud: false }, "/tmp/project").args).toEqual(["acp"]);
  });

  it("combines agent type, refusal fallbacks, and cloud in one spawn", () => {
    expect(
      buildDevinAcpSpawnInput(
        { agentType: "review", refusalFallback: "swe-2", cloud: true },
        "/tmp/project",
      ).args,
    ).toEqual(["acp", "--agent-type", "review", "--refusal-fallback", "swe-2", "--cloud"]);
  });
});

const stubSetConfigOption = (calls: Array<{ configId: string; value: string | boolean }>) => ({
  setConfigOption: (configId: string, value: string | boolean) =>
    Effect.sync(() => {
      calls.push({ configId, value });
      return {} as never;
    }),
});

describe("applyDevinAcpModelSelection", () => {
  it.effect("selects the requested model through ACP config", () => {
    const calls: string[] = [];
    return applyDevinAcpModelSelection({
      runtime: {
        getConfigOptions: noConfigOptions,
        setModel: (model) => Effect.sync(() => calls.push(model)).pipe(Effect.asVoid),
        ...stubSetConfigOption([]),
      },
      model: "claude-sonnet-4-6",
      mapError: ({ cause }) => cause,
    }).pipe(Effect.tap(() => Effect.sync(() => expect(calls).toEqual(["claude-sonnet-4-6"]))));
  });

  it.effect("folds a reasoning option into the full model UID", () => {
    const calls: string[] = [];
    return applyDevinAcpModelSelection({
      runtime: {
        getConfigOptions: noConfigOptions,
        setModel: (model) => Effect.sync(() => calls.push(model)).pipe(Effect.asVoid),
        ...stubSetConfigOption([]),
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
        getConfigOptions: noConfigOptions,
        setModel: (model) =>
          Effect.gen(function* () {
            calls.push(model);
            if (model.endsWith("-none")) {
              return yield* Effect.fail(new Error("unknown model") as never);
            }
          }),
        ...stubSetConfigOption([]),
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

  it.effect("degrades to a same-family UID the session enum offers", () => {
    const calls: string[] = [];
    return Effect.gen(function* () {
      const uid = yield* applyDevinAcpModelSelection({
        runtime: {
          getConfigOptions: Effect.succeed([modelConfigOption(["swe-2-high", "adaptive"])]),
          setModel: (model) =>
            Effect.gen(function* () {
              calls.push(model);
              if (model !== "swe-2-high") {
                return yield* Effect.fail(new Error("invalid value") as never);
              }
            }),
          ...stubSetConfigOption([]),
        },
        model: "swe-2",
        selections: [{ id: "reasoning", value: "__uid:swe-2-max" }],
        mapError: ({ cause }) => cause,
      });
      expect(uid).toBe("swe-2-high");
      expect(calls).toEqual(["swe-2-max", "swe-2-high"]);
    });
  });

  it.effect("maps a catalog-only tier to the enum member plus thought_level", () => {
    const modelCalls: string[] = [];
    const configCalls: Array<{ configId: string; value: string | boolean }> = [];
    return Effect.gen(function* () {
      const uid = yield* applyDevinAcpModelSelection({
        runtime: {
          getConfigOptions: Effect.succeed([
            modelConfigOption(["swe-2-high", "adaptive"]),
            thoughtLevelConfigOption(["medium", "high", "max"], "high"),
          ]),
          setModel: (model) =>
            Effect.gen(function* () {
              modelCalls.push(model);
              if (model !== "swe-2-high") {
                return yield* Effect.fail(new Error("invalid value") as never);
              }
            }),
          ...stubSetConfigOption(configCalls),
        },
        model: "swe-2",
        selections: [{ id: "reasoning", value: "__uid:swe-2-max" }],
        mapError: ({ cause }) => cause,
      });
      expect(uid).toBe("swe-2-max");
      expect(modelCalls).toEqual(["swe-2-max", "swe-2-high"]);
      expect(configCalls).toEqual([{ configId: "thought_level", value: "max" }]);
    });
  });

  it.effect("skips thought_level when the session offers no such option", () => {
    const configCalls: Array<{ configId: string; value: string | boolean }> = [];
    return Effect.gen(function* () {
      const uid = yield* applyDevinAcpModelSelection({
        runtime: {
          getConfigOptions: Effect.succeed([modelConfigOption(["adaptive"])]),
          setModel: () => Effect.void,
          ...stubSetConfigOption(configCalls),
        },
        model: "adaptive",
        mapError: ({ cause }) => cause,
      });
      expect(uid).toBe("adaptive");
      expect(configCalls).toEqual([]);
    });
  });

  it.effect("prefers the enum member matching the requested context window", () => {
    const modelCalls: string[] = [];
    const configCalls: Array<{ configId: string; value: string | boolean }> = [];
    return Effect.gen(function* () {
      const uid = yield* applyDevinAcpModelSelection({
        runtime: {
          getConfigOptions: Effect.succeed([
            modelConfigOption(["glm-5-2", "glm-5-2-1m", "adaptive"]),
            thoughtLevelConfigOption(["none", "high", "max"], "high"),
          ]),
          setModel: (model) =>
            Effect.gen(function* () {
              modelCalls.push(model);
              if (model === "glm-5-2-max-1m") {
                return yield* Effect.fail(new Error("invalid value") as never);
              }
            }),
          ...stubSetConfigOption(configCalls),
        },
        model: "glm-5-2",
        selections: [
          { id: "reasoning", value: "max" },
          { id: "contextWindow", value: "1m" },
        ],
        mapError: ({ cause }) => cause,
      });
      expect(uid).toBe("glm-5-2-max-1m");
      expect(modelCalls).toEqual(["glm-5-2-max-1m", "glm-5-2-1m"]);
      expect(configCalls).toEqual([{ configId: "thought_level", value: "max" }]);
    });
  });

  it.effect("keeps the enum member when its thought_level list lacks the tier", () => {
    const configCalls: Array<{ configId: string; value: string | boolean }> = [];
    return Effect.gen(function* () {
      const uid = yield* applyDevinAcpModelSelection({
        runtime: {
          getConfigOptions: Effect.succeed([
            modelConfigOption(["swe-1-7-medium", "adaptive"]),
            thoughtLevelConfigOption(["medium", "max"], "medium"),
          ]),
          setModel: (model) =>
            Effect.gen(function* () {
              if (model === "swe-1-7-low") {
                return yield* Effect.fail(new Error("invalid value") as never);
              }
            }),
          ...stubSetConfigOption(configCalls),
        },
        model: "swe-1-7",
        selections: [{ id: "reasoning", value: "low" }],
        mapError: ({ cause }) => cause,
      });
      expect(uid).toBe("swe-1-7-medium");
      expect(configCalls).toEqual([]);
    });
  });

  it.effect("applies a fusion lead effort through thought_level", () => {
    const configCalls: Array<{ configId: string; value: string | boolean }> = [];
    return Effect.gen(function* () {
      const uid = yield* applyDevinAcpModelSelection({
        runtime: {
          getConfigOptions: Effect.succeed([
            modelConfigOption(["fusion-gpt-5-6-sol-high-sidekick-swe-2-medium", "adaptive"]),
            thoughtLevelConfigOption(["low", "medium", "high", "xhigh", "max"], "high"),
          ]),
          setModel: (model) =>
            Effect.gen(function* () {
              if (model === "fusion-gpt-5-6-sol-xhigh-sidekick-swe-2-medium") {
                return yield* Effect.fail(new Error("invalid value") as never);
              }
            }),
          ...stubSetConfigOption(configCalls),
        },
        model: "fusion",
        selections: [
          {
            id: "__providerVariant",
            value: "fusion-gpt-5-6-sol-xhigh-sidekick-swe-2-medium",
          },
        ],
        mapError: ({ cause }) => cause,
      });
      expect(uid).toBe("fusion-gpt-5-6-sol-xhigh-sidekick-swe-2-medium");
      expect(configCalls).toEqual([{ configId: "thought_level", value: "xhigh" }]);
    });
  });

  it.effect("relaxes a catalogued fusion variant to the enum's non-fast form", () => {
    const calls: string[] = [];
    return applyDevinAcpModelSelection({
      runtime: {
        getConfigOptions: Effect.succeed([
          modelConfigOption(["fusion-gpt-5-6-sol-high-sidekick-swe-2-medium", "adaptive"]),
        ]),
        setModel: (model) =>
          Effect.gen(function* () {
            calls.push(model);
            if (model.includes("-fast")) {
              return yield* Effect.fail(new Error("invalid value") as never);
            }
          }),
        ...stubSetConfigOption([]),
      },
      model: "fusion",
      selections: [
        {
          id: "__providerVariant",
          value: "fusion-gpt-5-6-sol-high-fast-sidekick-swe-2-medium",
        },
      ],
      mapError: ({ cause }) => cause,
    }).pipe(
      Effect.tap(() =>
        Effect.sync(() =>
          expect(calls).toEqual([
            "fusion-gpt-5-6-sol-high-fast-sidekick-swe-2-medium",
            "fusion-gpt-5-6-sol-high-sidekick-swe-2-medium",
          ]),
        ),
      ),
    );
  });

  it("falls back to adaptive", () => {
    expect(resolveDevinAcpBaseModelId("  ")).toBe("adaptive");
  });

  it("maps every concrete fusion UID back to the stable fusion base", () => {
    expect(resolveDevinAcpBaseModelId("fusion")).toBe("fusion");
    expect(resolveDevinAcpBaseModelId("fusion-claude-opus-5-high-fast-sidekick-swe-2-medium")).toBe(
      "fusion",
    );
    expect(resolveDevinAcpBaseModelId("claude-opus-5-high")).toBe("claude-opus-5");
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

  it("dispatches a resolved __providerVariant UID verbatim", () => {
    expect(
      resolveDevinModelUid("fusion", [
        { id: "lead", value: "claude-opus-5" },
        { id: "effort", value: "high" },
        { id: "__providerVariant", value: "fusion-claude-opus-5-high-sidekick-swe-2" },
      ]),
    ).toBe("fusion-claude-opus-5-high-sidekick-swe-2");
  });

  it("ignores a blank __providerVariant value", () => {
    expect(
      resolveDevinModelUid("claude-opus-5", [
        { id: "__providerVariant", value: "   " },
        { id: "reasoning", value: "high" },
      ]),
    ).toBe("claude-opus-5-high");
  });
});

describe("resolveDevinSessionModelFallbacks", () => {
  it("returns no fallbacks when the UID is already allowed", () => {
    expect(resolveDevinSessionModelFallbacks("swe-2-high", ["swe-2-high"])).toEqual([]);
  });

  it("returns no fallbacks when the session advertises no model enum", () => {
    expect(resolveDevinSessionModelFallbacks("swe-2-max", [])).toEqual([]);
  });

  it("offers same-family enum members for an unlisted variant", () => {
    expect(
      resolveDevinSessionModelFallbacks("swe-2-max", [
        "adaptive",
        "swe-2-high",
        "gpt-5-3-codex-medium",
      ]),
    ).toEqual(["swe-2-high"]);
  });

  it("prefers the same reasoning tier when another qualifier differs", () => {
    expect(
      resolveDevinSessionModelFallbacks("glm-5-3-max-1m", ["glm-5-3-flash-max", "glm-5-3-max"]),
    ).toEqual(["glm-5-3-max"]);
  });

  it("excludes fusion UIDs from non-fusion family matches", () => {
    expect(
      resolveDevinSessionModelFallbacks("swe-2-max", [
        "fusion-claude-opus-5-high-sidekick-swe-2-medium",
        "swe-2-high",
      ]),
    ).toEqual(["swe-2-high"]);
  });

  it("relaxes fusion lead speed, then effort, then sidekick tier", () => {
    const allowed = [
      "fusion-gpt-5-6-sol-high-sidekick-swe-2-medium",
      "fusion-gpt-5-6-sol-medium-sidekick-swe-2-medium",
      "fusion-gpt-5-6-sol-medium-sidekick-swe-2-high",
    ];
    expect(
      resolveDevinSessionModelFallbacks(
        "fusion-gpt-5-6-sol-high-fast-sidekick-swe-2-medium",
        allowed,
      ),
    ).toEqual([
      "fusion-gpt-5-6-sol-high-sidekick-swe-2-medium",
      "fusion-gpt-5-6-sol-medium-sidekick-swe-2-medium",
      "fusion-gpt-5-6-sol-medium-sidekick-swe-2-high",
    ]);
  });

  it("prefers the family member matching the requested context window", () => {
    expect(
      resolveDevinSessionModelFallbacks("glm-5-3-high-1m", ["glm-5-3-max", "glm-5-3-max-1m"]),
    ).toEqual(["glm-5-3-max-1m", "glm-5-3-max"]);
  });
});

describe("resolveDevinEffectiveModelUid", () => {
  it("recombines an enum member and thought level into the catalog UID", () => {
    expect(resolveDevinEffectiveModelUid("swe-2-high", "max")).toBe("swe-2-max");
    expect(resolveDevinEffectiveModelUid("claude-opus-5-5-medium", "xhigh")).toBe(
      "claude-opus-5-5-xhigh",
    );
  });

  it("preserves the enum member's context window suffix", () => {
    expect(resolveDevinEffectiveModelUid("glm-5-2-1m", "max")).toBe("glm-5-2-max-1m");
    expect(resolveDevinEffectiveModelUid("glm-5-2-1m", "high")).toBe("glm-5-2-1m");
  });

  it("uses GLM's unsuffixed form for the high tier", () => {
    expect(resolveDevinEffectiveModelUid("glm-5-2", "high")).toBe("glm-5-2");
    expect(resolveDevinEffectiveModelUid("glm-5-2", "none")).toBe("glm-5-2-none");
  });

  it("rewrites a fusion UID's lead effort", () => {
    expect(
      resolveDevinEffectiveModelUid("fusion-gpt-5-6-sol-high-sidekick-swe-2-medium", "xhigh"),
    ).toBe("fusion-gpt-5-6-sol-xhigh-sidekick-swe-2-medium");
  });
});
