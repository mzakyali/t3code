// @effect-diagnostics nodeBuiltinImport:off
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Cause from "effect/Cause";
import * as Schema from "effect/Schema";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/unstable/process";
import * as NodePath from "node:path";

import {
  DevinRulesProbeError,
  discoverDevinRules,
  parseDevinRulesListOutput,
} from "./DevinRules.ts";

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

describe("parseDevinRulesListOutput", () => {
  it("parses the canonical `name [Provider] activation` listing", () => {
    const rules = parseDevinRulesListOutput(
      "Available Rules\n\n  global_rules [Windsurf] always-on\n  cursor-cloud [Cursor] always-on\n  AGENTS [Standard] always-on\n  CLAUDE [Claude] always-on\n",
    );

    expect(rules).toEqual([
      { name: "AGENTS", provider: "Standard", activation: "always-on" },
      { name: "CLAUDE", provider: "Claude", activation: "always-on" },
      { name: "cursor-cloud", provider: "Cursor", activation: "always-on" },
      { name: "global_rules", provider: "Windsurf", activation: "always-on" },
    ]);
  });

  it("handles records without a provider bracket or activation", () => {
    const rules = parseDevinRulesListOutput("my-rule\nother-rule [Custom]\n");

    expect(rules).toEqual([{ name: "my-rule" }, { name: "other-rule", provider: "Custom" }]);
  });

  it("skips headers and notices instead of failing", () => {
    const rules = parseDevinRulesListOutput(
      "Available Rules\n\n  alpha [Standard] always-on\n\nNo rules configured for this project.\n",
    );

    expect(rules).toEqual([{ name: "alpha", provider: "Standard", activation: "always-on" }]);
  });

  it("deduplicates case-insensitively keeping the first record", () => {
    const rules = parseDevinRulesListOutput("Deploy [A] always-on\ndeploy [B] manual\n");

    expect(rules).toEqual([{ name: "Deploy", provider: "A", activation: "always-on" }]);
  });

  it("returns an empty array for an empty or all-chrome listing", () => {
    expect(parseDevinRulesListOutput("")).toEqual([]);
    expect(parseDevinRulesListOutput("Available Rules\n\nNo rules found.\n")).toEqual([]);
  });
});

const isDevinRulesProbeError = Schema.is(DevinRulesProbeError);

const findProbeError = (exit: Exit.Exit<unknown, unknown>): DevinRulesProbeError | undefined => {
  if (Exit.isSuccess(exit)) return undefined;
  const failReason = exit.cause.reasons.find(Cause.isFailReason);
  return isDevinRulesProbeError(failReason?.error) ? failReason.error : undefined;
};

describe("discoverDevinRules", () => {
  it.effect("passes the workspace cwd to the command", () =>
    Effect.gen(function* () {
      const observed: { cwds: Array<string | undefined>; commands: Array<string> } = {
        cwds: [],
        commands: [],
      };
      const cwd = NodePath.resolve(process.cwd());
      yield* discoverDevinRules({ binaryPath: "devin" }, {}, cwd).pipe(
        Effect.provideService(
          ChildProcessSpawner.ChildProcessSpawner,
          makeListSpawner("Available Rules\n", 0, observed),
        ),
      );

      expect(observed.cwds).toContain(cwd);
    }),
  );

  it.effect("returns parsed rules for a successful listing", () =>
    Effect.gen(function* () {
      const rules = yield* discoverDevinRules({ binaryPath: "devin" }, {}).pipe(
        Effect.provideService(
          ChildProcessSpawner.ChildProcessSpawner,
          makeListSpawner("  global_rules [Windsurf] always-on\n"),
        ),
      );
      expect(rules).toEqual([
        { name: "global_rules", provider: "Windsurf", activation: "always-on" },
      ]);
    }),
  );

  it.effect("fails with a typed exit error on nonzero exit", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(
        discoverDevinRules({ binaryPath: "devin" }, {}).pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, makeListSpawner("", 2)),
        ),
      );
      const error = findProbeError(exit);
      expect(error?.stage).toBe("exit");
      expect(error?.exitCode).toBe(2);
    }),
  );
});
