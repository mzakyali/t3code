/**
 * DevinMcpConfig — installs the per-thread T3 MCP server into the Devin
 * workspace's local MCP config.
 *
 * `devin acp` advertises `mcpCapabilities: { http: false, sse: false }` and
 * ignores `session/new.mcpServers`; the agent loads MCP servers from its own
 * scoped config files instead. The narrowest non-committed scope it merges is
 * the workspace file `.devin/mcp_config.local.json`, so the adapter installs
 * the `t3-code` entry before spawning the process and restores the file when
 * the session scope closes. The entry is merged key-by-key so user-managed
 * servers in the same file survive both directions.
 *
 * Two threads sharing one workspace cwd share the `t3-code` key: the later
 * install wins in the file while each spawned process keeps the token it read
 * at startup. That is the narrowest correct scope the CLI offers — the user
 * config would leak a per-thread token into every Devin session on the
 * machine.
 *
 * @module provider/Drivers/DevinMcpConfig
 */
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";

import { fromJsonStringPretty } from "@t3tools/shared/schemaJson";

import { writeFileStringAtomically } from "../../atomicWrite.ts";

export const DEVIN_MCP_SERVER_NAME = "t3-code";

const CONFIG_DIR_NAME = ".devin";
const CONFIG_FILE_NAME = "mcp_config.local.json";

const ConfigJson = Schema.fromJsonString(Schema.Unknown);
const ConfigJsonPretty = fromJsonStringPretty(Schema.Unknown);
const decodeConfigJson = Schema.decodeUnknownEffect(ConfigJson);
const encodeConfigJson = Schema.encodeUnknownEffect(ConfigJsonPretty);

export class DevinMcpConfigError extends Schema.TaggedError<DevinMcpConfigError>()(
  "DevinMcpConfigError",
  {
    stage: Schema.Literals(["read", "parse", "write"]),
    filePath: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Devin workspace MCP config failed during ${this.stage} for '${this.filePath}'.`;
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

type McpConfigObject = Record<string, unknown> & {
  mcpServers?: Record<string, unknown>;
};

/**
 * Reads and parses the config file. `undefined` means the file does not
 * exist; an unparseable or non-object payload fails instead of being
 * clobbered by the merge.
 */
const readConfig = (
  filePath: string,
): Effect.Effect<McpConfigObject | undefined, DevinMcpConfigError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const text = yield* fs.readFileString(filePath).pipe(
      Effect.map(Option.some),
      Effect.catchIf(
        (error) => error.reason._tag === "NotFound",
        () => Effect.succeed(Option.none<string>()),
      ),
      Effect.mapError((cause) => new DevinMcpConfigError({ stage: "read", filePath, cause })),
    );
    if (Option.isNone(text)) return undefined;
    const parsed = yield* decodeConfigJson(text.value).pipe(
      Effect.mapError((cause) => new DevinMcpConfigError({ stage: "parse", filePath, cause })),
    );
    if (!isRecord(parsed) || (parsed.mcpServers !== undefined && !isRecord(parsed.mcpServers))) {
      return yield* new DevinMcpConfigError({ stage: "parse", filePath });
    }
    return parsed;
  });

const writeConfig = (
  filePath: string,
  config: McpConfigObject,
): Effect.Effect<void, DevinMcpConfigError, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const serialized = yield* encodeConfigJson(config);
    return yield* writeFileStringAtomically({
      filePath,
      contents: `${serialized}\n`,
    });
  }).pipe(Effect.mapError((cause) => new DevinMcpConfigError({ stage: "write", filePath, cause })));

export interface DevinWorkspaceMcpServer {
  readonly name: string;
  readonly url: string;
  readonly authorizationHeader: string;
}

/**
 * Merges `server` into `<cwd>/.devin/mcp_config.local.json` and registers a
 * finalizer on `scope` that puts the file back. Restore re-reads the file so
 * edits made while the session ran are preserved; when the install created
 * the file and nothing else remains, the file (and the `.devin` directory it
 * created) is removed. Restore never fails scope close — it logs and leaves
 * the file rather than risk deleting user content.
 */
export const installDevinWorkspaceMcpServer = Effect.fn("installDevinWorkspaceMcpServer")(
  function* (input: {
    readonly cwd: string;
    readonly scope: Scope.Scope;
    readonly server: DevinWorkspaceMcpServer;
  }) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const configDir = path.join(input.cwd, CONFIG_DIR_NAME);
    const filePath = path.join(configDir, CONFIG_FILE_NAME);
    const serverName = input.server.name;

    const dirExisted = yield* fs.stat(configDir).pipe(
      Effect.map((stat) => stat.type === "Directory"),
      Effect.option,
      Effect.map(Option.getOrElse(() => false)),
    );
    const prior = yield* readConfig(filePath);
    const hadFile = prior !== undefined;
    const priorServers = prior?.mcpServers ?? {};
    const priorEntry = Object.hasOwn(priorServers, serverName)
      ? Option.some(priorServers[serverName])
      : Option.none<unknown>();

    yield* writeConfig(filePath, {
      ...prior,
      mcpServers: {
        ...priorServers,
        [serverName]: {
          url: input.server.url,
          transport: "http",
          headers: { Authorization: input.server.authorizationHeader },
        },
      },
    });

    // fs.rm needs `recursive` to remove a directory at all, so the empty
    // check is what keeps a `.devin` dir the user filled mid-session alive.
    const removeConfigDirIfEmpty = Effect.gen(function* () {
      const entries = yield* fs.readDirectory(configDir).pipe(Effect.option);
      if (Option.isSome(entries) && entries.value.length === 0) {
        yield* fs.remove(configDir, { recursive: true }).pipe(Effect.ignore);
      }
    });

    yield* Scope.addFinalizer(
      input.scope,
      Effect.gen(function* () {
        const current = yield* readConfig(filePath).pipe(
          Effect.catch((cause) =>
            Effect.logWarning(
              "Could not read the Devin workspace MCP config while restoring it; leaving it untouched.",
              { cause },
            ).pipe(Effect.as(undefined)),
          ),
        );
        // Missing file: nothing to merge. Unparseable file: left alone so a
        // restore never destroys user content.
        if (current === undefined) {
          if (!hadFile && !dirExisted) {
            yield* removeConfigDirIfEmpty;
          }
          return;
        }
        const servers = { ...(current.mcpServers ?? {}) };
        if (Option.isSome(priorEntry)) {
          servers[serverName] = priorEntry.value;
        } else {
          delete servers[serverName];
        }
        const next: McpConfigObject = { ...current };
        if (Object.keys(servers).length > 0) {
          next.mcpServers = servers;
        } else {
          delete next.mcpServers;
        }
        if (!hadFile && Object.keys(next).length === 0) {
          yield* fs.remove(filePath).pipe(Effect.ignore);
          if (!dirExisted) {
            yield* removeConfigDirIfEmpty;
          }
          return;
        }
        yield* writeConfig(filePath, next).pipe(
          Effect.catch((cause) =>
            Effect.logWarning(
              "Could not restore the Devin workspace MCP config; leaving it untouched.",
              { cause },
            ),
          ),
        );
      }).pipe(
        Effect.provideService(FileSystem.FileSystem, fs),
        Effect.provideService(Path.Path, path),
      ),
    );
  },
);
