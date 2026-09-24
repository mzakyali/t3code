// @effect-diagnostics nodeBuiltinImport:off
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeFSP from "node:fs/promises";
import { expect, it } from "@effect/vitest";
import { ProviderInstanceId } from "@t3tools/contracts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";
import { ChildProcessSpawner } from "effect/unstable/process";

import * as BackgroundPolicy from "../../background/BackgroundPolicy.ts";
import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { NoOpProviderEventLoggers, ProviderEventLoggers } from "../Layers/ProviderEventLoggers.ts";
import { DevinDriver } from "./DevinDriver.ts";

const encodeUnknownJson = Schema.encodeUnknownSync(Schema.fromJsonString(Schema.Unknown));

const testLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "t3-devin-driver-skills-",
}).pipe(
  Layer.provideMerge(NodeServices.layer),
  Layer.provideMerge(ServerSettingsService.layerTest()),
  Layer.provideMerge(Layer.succeed(ProviderEventLoggers, NoOpProviderEventLoggers)),
  Layer.provideMerge(
    Layer.mock(BackgroundPolicy.BackgroundPolicy)({
      shouldRunScopeWork: () => Effect.succeed(false),
    }),
  ),
  Layer.provideMerge(
    Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make(() => Effect.die("Tests must not make an HTTP request")),
    ),
  ),
);

// The `#!/bin/sh` stub below cannot be resolved as an executable on Windows.
const windowsHost = HostProcessPlatform.defaultValue() === "win32";

const makeSkillsBinary = Effect.fn("makeDevinSkillsBinary")(function* (options: {
  readonly skillsJson: string;
  readonly skillsExitCode?: number;
  readonly rulesOutput?: string;
  readonly rulesExitCode?: number;
  readonly modelsJson?: string;
  readonly modelsExitCode?: number;
}) {
  const dir = yield* Effect.promise(() =>
    NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "devin-driver-skills-")),
  );
  const binaryPath = NodePath.join(dir, "fake-devin.sh");
  const skillsJsonPath = NodePath.join(dir, "skills.json");
  const rulesPath = NodePath.join(dir, "rules.txt");
  const modelsJsonPath = NodePath.join(dir, "models.json");
  yield* Effect.promise(() => NodeFSP.writeFile(skillsJsonPath, options.skillsJson, "utf8"));
  yield* Effect.promise(() => NodeFSP.writeFile(rulesPath, options.rulesOutput ?? "", "utf8"));
  yield* Effect.promise(() =>
    NodeFSP.writeFile(modelsJsonPath, options.modelsJson ?? '{"families":[]}', "utf8"),
  );
  const script = `#!/bin/sh
if [ "$1" = "--version" ]; then
  echo "devin 1.0.0"
  exit 0
fi
if [ "$1" = "models" ]; then
  cat '${modelsJsonPath}'
  exit ${options.modelsExitCode ?? 0}
fi
if [ "$1" = "skills" ]; then
  cat '${skillsJsonPath}'
  exit ${options.skillsExitCode ?? 0}
fi
if [ "$1" = "rules" ]; then
  cat '${rulesPath}'
  exit ${options.rulesExitCode ?? 0}
fi
echo "unexpected command: $*" >&2
exit 1
`;
  yield* Effect.promise(() => NodeFSP.writeFile(binaryPath, script, "utf8"));
  yield* Effect.promise(() => NodeFSP.chmod(binaryPath, 0o755));
  return binaryPath;
});

const createInstance = (
  binaryPath: string,
  enabled: boolean,
  environment: ReadonlyArray<{ name: string; value: string; sensitive: boolean }> = [],
) =>
  DevinDriver.create({
    instanceId: ProviderInstanceId.make("devin-skills-test"),
    displayName: "Devin skills test",
    enabled,
    environment,
    config: { ...DevinDriver.defaultConfig(), binaryPath, enabled },
  });

it.layer(testLayer)("DevinDriver snapshotForCwd", (it) => {
  it.effect.skipIf(windowsHost)(
    "returns the normal snapshot without discovery when Devin is disabled",
    () =>
      Effect.gen(function* () {
        const noSpawn = Layer.succeed(
          ChildProcessSpawner.ChildProcessSpawner,
          ChildProcessSpawner.make(() =>
            Effect.die("Disabled Devin must not spawn a skills process"),
          ),
        );
        const instance = yield* createInstance("devin-unused", false).pipe(Effect.provide(noSpawn));
        const snapshot = yield* instance.snapshotForCwd!(process.cwd());

        expect(snapshot.skills).toEqual([]);
        expect(snapshot.enabled).toBe(false);
      }),
  );

  it.effect.skipIf(windowsHost)("includes discovered skills in the workspace snapshot", () =>
    Effect.gen(function* () {
      const binaryPath = yield* makeSkillsBinary({
        skillsJson: encodeUnknownJson([
          {
            name: "deploy",
            base_dir: "/tmp/skills/deploy",
            description: "Deploy the app.",
            triggers: ["user", "model"],
          },
        ]),
      });
      const instance = yield* createInstance(binaryPath, true);
      const snapshot = yield* instance.snapshotForCwd!(process.cwd());

      expect(snapshot.skills).toHaveLength(1);
      expect(snapshot.skills[0]).toMatchObject({ name: "deploy", enabled: true });
    }),
  );

  it.effect.skipIf(windowsHost)(
    "includes discovered rules alongside skills in the workspace snapshot",
    () =>
      Effect.gen(function* () {
        const binaryPath = yield* makeSkillsBinary({
          skillsJson: "[]",
          rulesOutput:
            "Available Rules\n\n  global_rules [Windsurf] always-on\n  AGENTS [Standard] always-on\n",
        });
        const instance = yield* createInstance(binaryPath, true);
        const snapshot = yield* instance.snapshotForCwd!(process.cwd());

        expect(snapshot.rules).toEqual([
          { name: "AGENTS", provider: "Standard", activation: "always-on" },
          { name: "global_rules", provider: "Windsurf", activation: "always-on" },
        ]);
      }),
  );

  it.effect.skipIf(windowsHost)(
    "degrades to an empty rules list when the CLI does not support rules",
    () =>
      Effect.gen(function* () {
        const binaryPath = yield* makeSkillsBinary({
          skillsJson: encodeUnknownJson([{ name: "deploy", base_dir: "/tmp/skills/deploy" }]),
          rulesExitCode: 2,
        });
        const instance = yield* createInstance(binaryPath, true);
        const snapshot = yield* instance.snapshotForCwd!(process.cwd());

        expect(snapshot.rules).toEqual([]);
        expect(snapshot.skills).toHaveLength(1);
      }),
  );

  it.effect.skipIf(windowsHost)(
    "fails with a typed error so the registry keeps the last valid snapshot",
    () =>
      Effect.gen(function* () {
        const binaryPath = yield* makeSkillsBinary({
          skillsJson: "[]",
          skillsExitCode: 3,
        });
        const instance = yield* createInstance(binaryPath, true);
        const exit = yield* Effect.exit(instance.snapshotForCwd!(process.cwd()));

        expect(Exit.isFailure(exit)).toBe(true);
      }),
  );

  it.effect.skipIf(windowsHost)(
    "attaches ACU usage limits to the probed snapshot when consumption credentials exist",
    () =>
      Effect.gen(function* () {
        const binaryPath = yield* makeSkillsBinary({ skillsJson: "[]" });
        const client = HttpClient.make((request) =>
          Effect.succeed(
            HttpClientResponse.fromWeb(
              request,
              request.url.includes("/acu-limits/devin")
                ? Response.json({
                    items: [{ cycle_acu_limit: 100, scope: "org", org_id: "org-123" }],
                    has_next_page: false,
                    end_cursor: null,
                  })
                : Response.json({ total_acus: 25, consumption_by_date: [] }),
            ),
          ),
        );
        const instance = yield* createInstance(binaryPath, true, [
          { name: "DEVIN_API_KEY", value: "cog_token", sensitive: true },
          { name: "DEVIN_ORG_ID", value: "org-123", sensitive: false },
        ]).pipe(Effect.provide(Layer.succeed(HttpClient.HttpClient, client)));

        const snapshot = yield* instance.snapshot.refresh;
        expect(snapshot.auth.status).toBe("authenticated");
        expect(snapshot.usageLimits?.windows[0]?.usedPercent).toBe(25);
        expect(snapshot.usageLimits?.windows[0]?.kind).toBe("monthly");
      }),
  );

  it.effect.skipIf(windowsHost)(
    "keeps the provider snapshot healthy when the consumption API forbids the credential",
    () =>
      Effect.gen(function* () {
        const binaryPath = yield* makeSkillsBinary({ skillsJson: "[]" });
        const client = HttpClient.make((request) =>
          Effect.succeed(HttpClientResponse.fromWeb(request, new Response(null, { status: 403 }))),
        );
        const instance = yield* createInstance(binaryPath, true, [
          { name: "DEVIN_API_KEY", value: "cog_token", sensitive: true },
          { name: "DEVIN_ORG_ID", value: "org-123", sensitive: false },
        ]).pipe(Effect.provide(Layer.succeed(HttpClient.HttpClient, client)));

        const snapshot = yield* instance.snapshot.refresh;
        expect(snapshot.status).toBe("ready");
        expect(snapshot.usageLimits?.windows).toEqual([]);
        expect(snapshot.usageLimits?.unavailable?.reason).toBe("unsupported");
      }),
  );

  it.effect.skipIf(windowsHost)(
    "reports usage limits as unsupported instead of probing when no consumption credential is configured",
    () =>
      Effect.gen(function* () {
        const binaryPath = yield* makeSkillsBinary({ skillsJson: "[]" });
        const client = HttpClient.make(() =>
          Effect.die("must not request usage without credentials"),
        );
        // Explicitly blank the credential names so a host-exported
        // DEVIN_API_KEY/DEVIN_ORG_ID cannot leak into the probe.
        const instance = yield* createInstance(binaryPath, true, [
          { name: "DEVIN_API_KEY", value: "", sensitive: false },
          { name: "DEVIN_PERSONAL_ACCESS_TOKEN", value: "", sensitive: false },
          { name: "DEVIN_ORG_ID", value: "", sensitive: false },
          { name: "DEVIN_ORGANIZATION_ID", value: "", sensitive: false },
        ]).pipe(Effect.provide(Layer.succeed(HttpClient.HttpClient, client)));

        const snapshot = yield* instance.snapshot.refresh;
        expect(snapshot.status).toBe("ready");
        expect(snapshot.usageLimits?.unavailable?.reason).toBe("unsupported");
      }),
  );
});
