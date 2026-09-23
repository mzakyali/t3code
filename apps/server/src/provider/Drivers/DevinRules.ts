/**
 * DevinRules — rule discovery via `devin rules list`.
 *
 * Parallel to DevinSkills: the Devin CLI reports the always-on instruction
 * files it will load (AGENTS.md, CLAUDE.md, Windsurf/Cursor rules, plugin
 * rules), so asking it beats reimplementing its discovery. Unlike skills,
 * the command emits human-readable text — `name [Provider] activation` —
 * so the parser is deliberately forgiving: lines that don't look like a
 * rule record are skipped, and a total parse miss yields an empty list
 * rather than a probe error.
 *
 * @module provider/Drivers/DevinRules
 */
import type { DevinSettings, ServerProviderRule } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { resolveSpawnCommand } from "@t3tools/shared/shell";

import { collectUint8StreamText } from "../../stream/collectUint8StreamText.ts";
import { isWindowsCommandNotFound } from "../../processRunner.ts";

/** Discovery budget matches the skills probe. */
export const DEVIN_RULES_PROBE_TIMEOUT_MS = 20_000;

/** Rule listings are tiny; anything past this is treated as a runaway. */
export const DEVIN_RULES_MAX_OUTPUT_BYTES = 1024 * 1024;

export class DevinRulesProbeError extends Schema.TaggedError<DevinRulesProbeError>()(
  "DevinRulesProbeError",
  {
    stage: Schema.Literals(["spawn", "timeout", "exit", "output-limit"]),
    cwd: Schema.optional(Schema.String),
    exitCode: Schema.optional(Schema.Number),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    const location = this.cwd === undefined ? "" : ` for '${this.cwd}'`;
    const exitCode = this.exitCode === undefined ? "" : ` with exit code ${this.exitCode}`;
    return `\`devin rules list\` failed during ${this.stage}${location}${exitCode}.`;
  }
}

/** `name [Provider] activation` — the canonical record shape. */
const RULE_WITH_PROVIDER_PATTERN = /^\s*(\S+)\s+\[([^\]]+)\](?:\s+(\S(?:.*\S)?))?\s*$/u;
/** Bare `name activation` fallback for providers that omit the bracket. */
const RULE_BARE_PATTERN = /^\s*(\S+)(?:\s+(\S(?:.*\S)?))?\s*$/u;

/** Lines that are output chrome rather than rule records. */
const NON_RULE_LINE_PATTERN = /^(?:available\s+rules|no\s+rules|rules\b|usage:|error:|warning:)/iu;

/**
 * Parse `devin rules list` output into provider rules. Lines that do not
 * resemble a record (headers, blank lines, notices) are skipped; the result
 * deduplicates by case-insensitive name, first record wins. An empty or
 * all-chrome listing returns an empty array — the command succeeding means
 * the answer is authoritative.
 */
export function parseDevinRulesListOutput(stdout: string): ReadonlyArray<ServerProviderRule> {
  const rulesByName = new Map<string, ServerProviderRule>();
  for (const line of stdout.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (!trimmed || NON_RULE_LINE_PATTERN.test(trimmed)) continue;

    let name: string | undefined;
    let provider: string | undefined;
    let activation: string | undefined;

    const withProvider = RULE_WITH_PROVIDER_PATTERN.exec(line);
    if (withProvider) {
      name = withProvider[1];
      provider = withProvider[2]?.trim() || undefined;
      activation = withProvider[3]?.trim() || undefined;
    } else {
      const bare = RULE_BARE_PATTERN.exec(line);
      if (!bare) continue;
      name = bare[1];
      activation = bare[2]?.trim() || undefined;
    }

    if (!name) continue;
    const key = name.toLowerCase();
    if (rulesByName.has(key)) continue;
    rulesByName.set(key, {
      name,
      ...(provider ? { provider } : {}),
      ...(activation ? { activation } : {}),
    });
  }
  return [...rulesByName.values()].sort((left, right) => left.name.localeCompare(right.name));
}

interface BoundedCommandResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly code: number;
  readonly truncated: boolean;
}

const spawnBoundedRulesCommand = (
  binaryPath: string,
  command: ChildProcess.Command,
): Effect.Effect<
  BoundedCommandResult,
  DevinRulesProbeError,
  ChildProcessSpawner.ChildProcessSpawner
> =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const child = yield* spawner
      .spawn(command)
      .pipe(Effect.mapError((cause) => new DevinRulesProbeError({ stage: "spawn", cause })));
    const [stdout, stderr, exitCode] = yield* Effect.all(
      [
        collectUint8StreamText({
          stream: child.stdout,
          maxBytes: DEVIN_RULES_MAX_OUTPUT_BYTES,
        }),
        collectUint8StreamText({
          stream: child.stderr,
          maxBytes: DEVIN_RULES_MAX_OUTPUT_BYTES,
        }),
        child.exitCode.pipe(Effect.map(Number)),
      ],
      { concurrency: "unbounded" },
    ).pipe(Effect.mapError((cause) => new DevinRulesProbeError({ stage: "spawn", cause })));

    if (yield* isWindowsCommandNotFound(exitCode, stderr.text)) {
      return yield* new DevinRulesProbeError({
        stage: "spawn",
        cause: new Error(`Devin command '${binaryPath}' was not found (exit code ${exitCode}).`),
      });
    }
    return {
      stdout: stdout.text,
      stderr: stderr.text,
      code: exitCode,
      truncated: stdout.truncated || stderr.truncated,
    };
  }).pipe(Effect.scoped);

const isDevinRulesProbeError = Schema.is(DevinRulesProbeError);

/**
 * Run `devin rules list` with the workspace as cwd and parse the reported
 * catalog. Spawn, timeout, nonzero exit, and output-limit failures surface
 * as typed `DevinRulesProbeError`s; a successful command with no parseable
 * lines is an authoritative empty result.
 */
export const discoverDevinRules = Effect.fn("discoverDevinRules")(function* (
  devinSettings: Pick<DevinSettings, "binaryPath">,
  environment: NodeJS.ProcessEnv = process.env,
  cwd?: string,
) {
  const command = devinSettings.binaryPath || "devin";
  const listResult = yield* Effect.gen(function* () {
    const spawnCommand = yield* resolveSpawnCommand(command, ["rules", "list"], {
      env: environment,
    });
    return yield* spawnBoundedRulesCommand(
      command,
      ChildProcess.make(spawnCommand.command, spawnCommand.args, {
        ...(cwd ? { cwd } : {}),
        env: environment,
        shell: spawnCommand.shell,
      }),
    );
  }).pipe(
    Effect.mapError((cause) =>
      isDevinRulesProbeError(cause)
        ? cause
        : new DevinRulesProbeError({
            stage: "spawn",
            ...(cwd ? { cwd } : {}),
            cause,
          }),
    ),
    Effect.timeoutOption(DEVIN_RULES_PROBE_TIMEOUT_MS),
  );

  if (Option.isNone(listResult)) {
    return yield* new DevinRulesProbeError({
      stage: "timeout",
      ...(cwd ? { cwd } : {}),
    });
  }
  const output = listResult.value;
  if (output.truncated) {
    return yield* new DevinRulesProbeError({
      stage: "output-limit",
      ...(cwd ? { cwd } : {}),
    });
  }
  if (output.code !== 0) {
    return yield* new DevinRulesProbeError({
      stage: "exit",
      ...(cwd ? { cwd } : {}),
      exitCode: output.code,
    });
  }
  return parseDevinRulesListOutput(output.stdout);
});
