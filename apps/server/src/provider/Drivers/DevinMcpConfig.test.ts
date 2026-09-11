// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";

import { DevinMcpConfigError, installDevinWorkspaceMcpServer } from "./DevinMcpConfig.ts";

const decodeUnknownJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
const encodeUnknownJson = Schema.encodeUnknownSync(Schema.fromJsonString(Schema.Unknown));

const server = {
  name: "t3-code",
  url: "http://127.0.0.1:43123/mcp",
  authorizationHeader: "Bearer test-token",
};

const installedEntry = {
  url: server.url,
  transport: "http",
  headers: { Authorization: server.authorizationHeader },
};

const configPathFor = (cwd: string) => NodePath.join(cwd, ".devin", "mcp_config.local.json");

const readConfigFile = (cwd: string) =>
  Effect.promise(() =>
    NodeFSP.readFile(configPathFor(cwd), "utf8").then(
      (contents) => {
        try {
          return decodeUnknownJson(contents) as Record<string, unknown>;
        } catch {
          return undefined;
        }
      },
      () => undefined,
    ),
  );

const makeWorkspace = () =>
  Effect.promise(() => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "devin-mcp-config-")));

const pathExists = (target: string) =>
  Effect.promise(() =>
    NodeFSP.stat(target).then(
      () => true,
      () => false,
    ),
  );

describe("installDevinWorkspaceMcpServer", () => {
  it.effect("installs the server entry and removes the created file and directory on restore", () =>
    Effect.gen(function* () {
      const cwd = yield* makeWorkspace();
      const scope = yield* Scope.make();
      yield* installDevinWorkspaceMcpServer({ cwd, scope, server });

      assert.deepEqual(yield* readConfigFile(cwd), {
        mcpServers: { "t3-code": installedEntry },
      });

      yield* Scope.close(scope, Exit.void);
      assert.isUndefined(yield* readConfigFile(cwd));
      assert.isFalse(yield* pathExists(NodePath.join(cwd, ".devin")));
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("merges into an existing file and only removes its own key on restore", () =>
    Effect.gen(function* () {
      const cwd = yield* makeWorkspace();
      const configPath = configPathFor(cwd);
      yield* Effect.promise(() => NodeFSP.mkdir(NodePath.dirname(configPath), { recursive: true }));
      const original = {
        mcpServers: { other: { url: "http://127.0.0.1:1/mcp", transport: "http" } },
        customKey: true,
      };
      yield* Effect.promise(() =>
        NodeFSP.writeFile(configPath, `${encodeUnknownJson(original)}\n`, "utf8"),
      );

      const scope = yield* Scope.make();
      yield* installDevinWorkspaceMcpServer({ cwd, scope, server });
      assert.deepEqual(yield* readConfigFile(cwd), {
        ...original,
        mcpServers: { ...original.mcpServers, "t3-code": installedEntry },
      });

      yield* Scope.close(scope, Exit.void);
      assert.deepEqual(yield* readConfigFile(cwd), original);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("restores a pre-existing entry that shares the server name", () =>
    Effect.gen(function* () {
      const cwd = yield* makeWorkspace();
      const configPath = configPathFor(cwd);
      yield* Effect.promise(() => NodeFSP.mkdir(NodePath.dirname(configPath), { recursive: true }));
      const priorEntry = { url: "http://127.0.0.1:9/mcp", transport: "http" };
      yield* Effect.promise(() =>
        NodeFSP.writeFile(
          configPath,
          `${encodeUnknownJson({ mcpServers: { "t3-code": priorEntry } })}\n`,
          "utf8",
        ),
      );

      const scope = yield* Scope.make();
      yield* installDevinWorkspaceMcpServer({ cwd, scope, server });
      assert.deepEqual(yield* readConfigFile(cwd), {
        mcpServers: { "t3-code": installedEntry },
      });

      yield* Scope.close(scope, Exit.void);
      assert.deepEqual(yield* readConfigFile(cwd), {
        mcpServers: { "t3-code": priorEntry },
      });
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("rejects a malformed config file without modifying it", () =>
    Effect.gen(function* () {
      const cwd = yield* makeWorkspace();
      const configPath = configPathFor(cwd);
      yield* Effect.promise(() => NodeFSP.mkdir(NodePath.dirname(configPath), { recursive: true }));
      yield* Effect.promise(() => NodeFSP.writeFile(configPath, "{not json", "utf8"));

      const scope = yield* Scope.make();
      const error = yield* installDevinWorkspaceMcpServer({ cwd, scope, server }).pipe(Effect.flip);
      assert.instanceOf(error, DevinMcpConfigError);
      assert.equal(error.stage, "parse");
      assert.equal(yield* Effect.promise(() => NodeFSP.readFile(configPath, "utf8")), "{not json");
      yield* Scope.close(scope, Exit.void);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("keeps entries added to the file while the session ran", () =>
    Effect.gen(function* () {
      const cwd = yield* makeWorkspace();
      const scope = yield* Scope.make();
      yield* installDevinWorkspaceMcpServer({ cwd, scope, server });

      const midSession = (yield* readConfigFile(cwd))!;
      midSession.mcpServers = {
        ...(midSession.mcpServers as Record<string, unknown>),
        other: { url: "http://127.0.0.1:2/mcp", transport: "http" },
      };
      yield* Effect.promise(() =>
        NodeFSP.writeFile(configPathFor(cwd), `${encodeUnknownJson(midSession)}\n`, "utf8"),
      );

      yield* Scope.close(scope, Exit.void);
      assert.deepEqual(yield* readConfigFile(cwd), {
        mcpServers: { other: { url: "http://127.0.0.1:2/mcp", transport: "http" } },
      });
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("restore tolerates the file being deleted while the session ran", () =>
    Effect.gen(function* () {
      const cwd = yield* makeWorkspace();
      const scope = yield* Scope.make();
      yield* installDevinWorkspaceMcpServer({ cwd, scope, server });
      yield* Effect.promise(() => NodeFSP.rm(configPathFor(cwd)));

      yield* Scope.close(scope, Exit.void);
      assert.isFalse(yield* pathExists(NodePath.join(cwd, ".devin")));
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
