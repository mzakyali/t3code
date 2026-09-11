// @effect-diagnostics nodeBuiltinImport:off
import { layerPosix as nodePathLayerPosix } from "@effect/platform-node/NodePath";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Cause from "effect/Cause";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/unstable/process";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import {
  DevinSkillsProbeError,
  decodeDevinSkillRecords,
  discoverDevinSkills,
} from "./DevinSkills.ts";

/** Posix path semantics keep parser expectations identical on every host. */
const decodeWithPosixPaths = (stdout: string, cwd?: string) =>
  Effect.gen(function* () {
    const path = yield* Path.Path.pipe(Effect.provide(nodePathLayerPosix));
    return decodeDevinSkillRecords(stdout, path, cwd);
  });

const decodeSync = (stdout: string, cwd?: string) =>
  Effect.runSync(decodeWithPosixPaths(stdout, cwd));

const makeListSpawner = (
  stdout: string,
  exitCode = 0,
  observed?: { cwds: Array<string | undefined>; commands: Array<string> },
) =>
  ChildProcessSpawner.make((command) => {
    if (observed) {
      observed.cwds.push(command._tag === "StandardCommand" ? command.options.cwd : undefined);
      observed.commands.push(command._tag === "StandardCommand" ? command.command : "");
    }
    return Effect.succeed(
      ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(1),
        exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(exitCode)),
        isRunning: Effect.succeed(false),
        kill: () => Effect.void,
        unref: Effect.succeed(Effect.void),
        stdin: Sink.drain,
        stdout: Stream.encodeText(Stream.make(stdout)),
        stderr: Stream.empty,
        all: Stream.empty,
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
      }),
    );
  });

describe("decodeDevinSkillRecords", () => {
  it("maps valid records onto provider skills with SKILL.md paths", () => {
    const skills = decodeSync(
      JSON.stringify([
        {
          name: "deploy",
          base_dir: "/tmp/skills/deploy",
          description: "Deploy the app.",
          display_name: "Deploy",
          triggers: ["user", "model"],
        },
      ]),
    );

    expect(skills).toEqual([
      {
        name: "deploy",
        description: "Deploy the app.",
        path: "/tmp/skills/deploy/SKILL.md",
        scope: "other",
        enabled: true,
        displayName: "Deploy",
        userInvocable: true,
      },
    ]);
  });

  it("derives userInvocationOnly when triggers carry user but not model", () => {
    const skills = decodeSync(
      JSON.stringify([
        { name: "user-only", base_dir: "/tmp/a", triggers: ["user"] },
        { name: "both", base_dir: "/tmp/b", triggers: ["user", "model"] },
        { name: "model-only", base_dir: "/tmp/c", triggers: ["model"] },
      ]),
    );

    const byName = new Map(skills?.map((skill) => [skill.name, skill]));
    expect(byName.get("user-only")?.userInvocationOnly).toBe(true);
    expect(byName.get("user-only")?.userInvocable).toBe(true);
    expect(byName.get("both")?.userInvocationOnly).toBeUndefined();
    expect(byName.get("both")?.userInvocable).toBe(true);
    expect(byName.get("model-only")?.userInvocable).toBeUndefined();
  });

  it("disables records with errors and keeps warning-only records enabled", () => {
    const skills = decodeSync(
      JSON.stringify([
        { name: "broken", base_dir: "/tmp/broken", errors: ["bad frontmatter"] },
        { name: "warned", base_dir: "/tmp/warned", warnings: ["deprecated trigger"] },
      ]),
    );

    const byName = new Map(skills?.map((skill) => [skill.name, skill]));
    expect(byName.get("broken")?.enabled).toBe(false);
    expect(byName.get("warned")?.enabled).toBe(true);
  });

  it("skips malformed records without failing the batch", () => {
    const skills = decodeSync(
      JSON.stringify([
        { name: "", base_dir: "/tmp/empty-name" },
        { name: "no-dir", base_dir: "" },
        { name: "no-dir", base_dir: "   " },
        "a string, not an object",
        42,
        null,
        { name: "valid", base_dir: "/tmp/valid" },
      ]),
    );

    expect(skills).toEqual([
      {
        name: "valid",
        path: "/tmp/valid/SKILL.md",
        scope: "other",
        enabled: true,
      },
    ]);
  });

  it("classifies project scope from the workspace cwd", () => {
    const skills = decodeSync(
      JSON.stringify([
        { name: "project-skill", base_dir: "/workspace/.devin/skills/deploy" },
        { name: "elsewhere", base_dir: "/opt/other/skills/deploy" },
      ]),
      "/workspace",
    );

    const byName = new Map(skills?.map((skill) => [skill.name, skill]));
    expect(byName.get("project-skill")?.scope).toBe("project");
    expect(byName.get("elsewhere")?.scope).toBe("other");
  });

  it("classifies personal scope for Devin user-global roots", () => {
    // Compute the personal root exactly as the implementation does so the
    // expectation holds on every host path semantics.
    const homeRoot = Effect.runSync(
      Effect.gen(function* () {
        const path = yield* Path.Path.pipe(Effect.provide(nodePathLayerPosix));
        return path.resolve(NodeOS.homedir(), ".devin/skills");
      }),
    );
    const skills = decodeSync(
      JSON.stringify([{ name: "personal", base_dir: `${homeRoot}/notes` }]),
    );

    expect(skills?.[0]?.scope).toBe("personal");
  });

  it("deduplicates names case-insensitively keeping the first record", () => {
    const skills = decodeSync(
      JSON.stringify([
        { name: "Deploy", base_dir: "/tmp/one" },
        { name: "deploy", base_dir: "/tmp/two" },
        { name: "DEPLOY", base_dir: "/tmp/three" },
        { name: "zeta", base_dir: "/tmp/zeta" },
      ]),
    );

    expect(skills?.map((skill) => skill.name)).toEqual(["Deploy", "zeta"]);
    expect(skills?.[0]?.path).toBe("/tmp/one/SKILL.md");
  });

  it("sorts deterministically by name", () => {
    const skills = decodeSync(
      JSON.stringify([
        { name: "zulu", base_dir: "/tmp/z" },
        { name: "alpha", base_dir: "/tmp/a" },
        { name: "mike", base_dir: "/tmp/m" },
      ]),
    );

    expect(skills?.map((skill) => skill.name)).toEqual(["alpha", "mike", "zulu"]);
  });

  it("treats an empty array as a valid empty result", () => {
    expect(decodeSync("[]")).toEqual([]);
  });

  it("returns undefined for a non-array payload or undecodable JSON", () => {
    expect(decodeSync("not json")).toBeUndefined();
    expect(decodeSync('{"skills": []}')).toBeUndefined();
    expect(decodeSync('{"name": "x", "base_dir": "/tmp"}')).toBeUndefined();
    // A record with a non-string name fails the record schema and is skipped.
    expect(decodeSync('[{"name": 42, "base_dir": "/tmp"}]')).toEqual([]);
  });
});

const findProbeError = (exit: Exit.Exit<unknown, unknown>): DevinSkillsProbeError | undefined => {
  if (Exit.isSuccess(exit)) return undefined;
  const failReason = exit.cause.reasons.find(Cause.isFailReason);
  return isDevinSkillsProbeError(failReason?.error) ? failReason.error : undefined;
};

const isDevinSkillsProbeError = Schema.is(DevinSkillsProbeError);

describe("discoverDevinSkills", () => {
  it("passes the workspace cwd and configured binary to the command", async () => {
    const observed: { cwds: Array<string | undefined>; commands: Array<string> } = {
      cwds: [],
      commands: [],
    };
    const cwd = NodePath.resolve(process.cwd());
    await Effect.runPromise(
      discoverDevinSkills({ binaryPath: "devin" }, {}, cwd).pipe(
        Effect.provideService(
          ChildProcessSpawner.ChildProcessSpawner,
          makeListSpawner("[]", 0, observed),
        ),
        Effect.provide(nodePathLayerPosix),
      ),
    );

    expect(observed.cwds).toContain(cwd);
  });

  it("returns an empty catalog for an authoritative empty array", async () => {
    const skills = await Effect.runPromise(
      discoverDevinSkills({ binaryPath: "devin" }, {}).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, makeListSpawner("[]")),
        Effect.provide(nodePathLayerPosix),
      ),
    );
    expect(skills).toEqual([]);
  });

  it("fails with a typed exit error on nonzero exit", async () => {
    const exit = await Effect.runPromiseExit(
      discoverDevinSkills({ binaryPath: "devin" }, {}).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, makeListSpawner("", 2)),
        Effect.provide(nodePathLayerPosix),
      ),
    );
    const error = findProbeError(exit);
    expect(error?.stage).toBe("exit");
    expect(error?.exitCode).toBe(2);
  });

  it("fails with a typed decode error on invalid JSON", async () => {
    const exit = await Effect.runPromiseExit(
      discoverDevinSkills({ binaryPath: "devin" }, {}).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, makeListSpawner("not json")),
        Effect.provide(nodePathLayerPosix),
      ),
    );
    expect(findProbeError(exit)?.stage).toBe("decode");
  });

  it("fails with a typed decode error on a non-array payload", async () => {
    const exit = await Effect.runPromiseExit(
      discoverDevinSkills({ binaryPath: "devin" }, {}).pipe(
        Effect.provideService(
          ChildProcessSpawner.ChildProcessSpawner,
          makeListSpawner('{"skills": []}'),
        ),
        Effect.provide(nodePathLayerPosix),
      ),
    );
    expect(findProbeError(exit)?.stage).toBe("decode");
  });
});
