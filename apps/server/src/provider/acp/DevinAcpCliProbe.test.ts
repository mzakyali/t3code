/**
 * Optional integration checks against a real `devin` CLI installation.
 * Enable with: T3_DEVIN_ACP_PROBE=1 vp test run DevinAcpCliProbe
 * Set T3_DEVIN_BINARY_PATH when `devin` is not on PATH.
 *
 * Set T3_DEVIN_LIVE_TURN=1 to send a real prompt. This consumes Devin usage.
 * The regular Devin adapter tests use the local ACP fixture for permissions,
 * cancellation, image input, and failure recovery; these checks validate the
 * installed CLI's command and ACP compatibility at the opt-in boundary.
 */
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import * as Schema from "effect/Schema";
import { DevinSettings } from "@t3tools/contracts";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import { describe, expect } from "vite-plus/test";

import { checkDevinProviderStatus } from "../Layers/DevinProvider.ts";
import { spawnAndCollect } from "../providerSnapshot.ts";
import { makeDevinAcpRuntime } from "./DevinAcpSupport.ts";

const configuredBinary = process.env.T3_DEVIN_BINARY_PATH?.trim() || "devin";
const decodeDevinSettings = Schema.decodeSync(DevinSettings);

const makeProbeSettings = () =>
  decodeDevinSettings({
    enabled: true,
    binaryPath: configuredBinary,
    customModels: [],
  });

const runDevinCommand = (args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const spawn = yield* resolveSpawnCommand(configuredBinary, args, { env: process.env });
    return yield* spawnAndCollect(
      configuredBinary,
      ChildProcess.make(spawn.command, spawn.args, {
        env: process.env,
        shell: spawn.shell,
      }),
    );
  });

const makeProbeRuntime = Effect.gen(function* () {
  const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  return yield* makeDevinAcpRuntime({
    devinSettings: { binaryPath: configuredBinary },
    environment: process.env,
    childProcessSpawner,
    cwd: process.cwd(),
    clientInfo: { name: "t3-devin-probe", version: "0.0.0" },
  });
});

describe.runIf(process.env.T3_DEVIN_ACP_PROBE === "1")("Devin ACP CLI probe", () => {
  it.effect("reports the real CLI auth state without invoking login", () =>
    runDevinCommand(["auth", "status"]).pipe(
      Effect.tap((result) =>
        Effect.sync(() => {
          const output = `${result.stdout}\n${result.stderr}`;
          expect(result.code).toBe(0);
          expect(output).toMatch(/logged in|authenticated/iu);
        }),
      ),
      Effect.provide(NodeServices.layer),
    ),
  );

  it.effect("discovers the current model catalog through the provider health check", () =>
    checkDevinProviderStatus(makeProbeSettings(), process.env).pipe(
      Effect.tap((snapshot) =>
        Effect.sync(() => {
          expect(snapshot.installed).toBe(true);
          expect(snapshot.status).toBe("ready");
          expect(snapshot.auth.status).toBe("authenticated");
          expect(snapshot.models.length).toBeGreaterThan(0);
          expect(snapshot.models.some((model) => model.slug === "adaptive")).toBe(true);
        }),
      ),
      Effect.provide(NodeServices.layer),
    ),
  );

  it.effect("starts a real ACP session and accepts an advertised model selection", () =>
    Effect.gen(function* () {
      const runtime = yield* makeProbeRuntime;
      const started = yield* runtime.start();
      expect(typeof started.sessionId).toBe("string");
      expect(started.initializeResult).toBeDefined();
      expect(started.sessionSetupResult).toBeDefined();

      const configOptions = yield* runtime.getConfigOptions;
      const modelConfig = configOptions.find(
        (option) => option.category === "model" || option.id === started.modelConfigId,
      );
      expect(modelConfig).toBeDefined();
      expect(modelConfig?.type).toBe("select");
      if (modelConfig?.type !== "select") return;

      const values = modelConfig.options.flatMap((option) =>
        "value" in option ? [option.value] : option.options.map((nested) => nested.value),
      );
      expect(values.length).toBeGreaterThan(0);
      const target = values.find((value) => value !== modelConfig.currentValue);
      yield* runtime.setModel(target ?? modelConfig.currentValue);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect.skipIf(process.env.T3_DEVIN_LIVE_TURN !== "1")(
    "finishes a real Devin turn and streams its answer",
    () =>
      Effect.gen(function* () {
        const runtime = yield* makeProbeRuntime;
        yield* runtime.start();
        const chunks: string[] = [];
        const events = yield* Stream.runForEach(runtime.getEvents(), (event) => {
          if (event._tag === "EventStreamBarrier") {
            return Deferred.succeed(event.acknowledge, undefined);
          }
          if (event._tag === "ContentDelta") {
            chunks.push(event.text);
          }
          return Effect.void;
        }).pipe(Effect.forkChild);
        const result = yield* runtime.prompt({
          prompt: [{ type: "text", text: "Reply exactly T3_DEVIN_OK. Do not use any tools." }],
        });
        yield* runtime.drainEvents;
        expect(result.stopReason).toBe("end_turn");
        expect(chunks.join("")).toContain("T3_DEVIN_OK");
        yield* Fiber.interrupt(events);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
