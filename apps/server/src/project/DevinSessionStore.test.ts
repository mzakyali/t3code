import * as NodeServices from "@effect/platform-node/NodeServices";
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeSqlite from "node:sqlite";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import * as DevinSessionStore from "./DevinSessionStore.ts";

interface FixtureSession {
  readonly id: string;
  readonly workingDirectory: string;
  readonly title?: string | null;
  readonly model?: string;
  readonly createdAt: number;
  readonly lastActivityAt: number;
  readonly mainChainId?: number | null;
  readonly hidden?: boolean;
}

interface FixtureNode {
  readonly sessionId: string;
  readonly nodeId: number;
  readonly parentNodeId?: number | null;
  readonly chatMessage: string;
  readonly createdAt: number;
}

const chatMessage = (role: string, content: unknown, createdAt?: string) =>
  JSON.stringify({
    role,
    content,
    ...(createdAt === undefined ? {} : { metadata: { created_at: createdAt } }),
  });

const createDevinDb = Effect.fn("DevinSessionStore.test.createDevinDb")(function* (input: {
  readonly directory: string;
  readonly sessions: ReadonlyArray<FixtureSession>;
  readonly nodes: ReadonlyArray<FixtureNode>;
}) {
  const path = yield* Path.Path;
  const fileSystem = yield* FileSystem.FileSystem;
  yield* fileSystem.makeDirectory(input.directory, { recursive: true });
  const dbPath = path.join(input.directory, "sessions.db");
  yield* Effect.acquireUseRelease(
    Effect.sync(() => new NodeSqlite.DatabaseSync(dbPath)),
    (db) =>
      Effect.sync(() => {
        db.exec(`CREATE TABLE sessions (
          id TEXT PRIMARY KEY,
          working_directory TEXT NOT NULL,
          backend_type TEXT NOT NULL DEFAULT 'local',
          model TEXT NOT NULL DEFAULT '',
          agent_mode TEXT NOT NULL DEFAULT '',
          created_at INTEGER NOT NULL,
          last_activity_at INTEGER NOT NULL,
          title TEXT,
          main_chain_id INTEGER,
          hidden INTEGER NOT NULL DEFAULT 0
        )`);
        db.exec(`CREATE TABLE message_nodes (
          row_id INTEGER PRIMARY KEY AUTOINCREMENT,
          session_id TEXT NOT NULL,
          node_id INTEGER NOT NULL,
          parent_node_id INTEGER,
          chat_message TEXT NOT NULL,
          created_at INTEGER NOT NULL
        )`);
        const insertSession = db.prepare(
          `INSERT INTO sessions
            (id, working_directory, model, created_at, last_activity_at, title, main_chain_id, hidden)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        );
        for (const session of input.sessions) {
          insertSession.run(
            session.id,
            session.workingDirectory,
            session.model ?? "adaptive",
            session.createdAt,
            session.lastActivityAt,
            session.title ?? null,
            session.mainChainId ?? null,
            session.hidden === true ? 1 : 0,
          );
        }
        const insertNode = db.prepare(
          `INSERT INTO message_nodes
            (session_id, node_id, parent_node_id, chat_message, created_at)
          VALUES (?, ?, ?, ?, ?)`,
        );
        for (const node of input.nodes) {
          insertNode.run(
            node.sessionId,
            node.nodeId,
            node.parentNodeId ?? null,
            node.chatMessage,
            node.createdAt,
          );
        }
      }),
    (db) => Effect.sync(() => db.close()),
  );
  return dbPath;
});

const makeTempDir = Effect.fn("DevinSessionStore.test.makeTempDir")(function* (prefix: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  return yield* fileSystem.makeTempDirectoryScoped({ prefix });
});

it.layer(NodeServices.layer)("DevinSessionStore", (it) => {
  it.effect("lists non-hidden sessions with visible message counts", () =>
    Effect.gen(function* () {
      const dir = yield* makeTempDir("t3code-devin-store-");
      const dbPath = yield* createDevinDb({
        directory: dir,
        sessions: [
          {
            id: "alpha",
            workingDirectory: "/work/alpha",
            title: "Alpha session",
            model: "opus",
            createdAt: 1_700_000_000,
            lastActivityAt: 1_700_100_000,
          },
          {
            id: "hidden-session",
            workingDirectory: "/work/hidden",
            createdAt: 1_700_000_000,
            lastActivityAt: 1_700_200_000,
            hidden: true,
          },
        ],
        nodes: [
          {
            sessionId: "alpha",
            nodeId: 1,
            chatMessage: chatMessage("system", "context"),
            createdAt: 1_700_000_000,
          },
          {
            sessionId: "alpha",
            nodeId: 2,
            parentNodeId: 1,
            chatMessage: chatMessage("user", "hello"),
            createdAt: 1_700_000_010,
          },
          {
            sessionId: "alpha",
            nodeId: 3,
            parentNodeId: 2,
            chatMessage: chatMessage("assistant", "hi there"),
            createdAt: 1_700_000_020,
          },
          {
            sessionId: "hidden-session",
            nodeId: 1,
            chatMessage: chatMessage("user", "secret"),
            createdAt: 1_700_000_000,
          },
        ],
      });

      const sessions = yield* DevinSessionStore.listSessions(dbPath);

      expect(sessions).toHaveLength(1);
      expect(sessions[0]).toMatchObject({
        sessionId: "alpha",
        workspaceRoot: "/work/alpha",
        title: "Alpha session",
        model: "opus",
        createdAtMs: 1_700_000_000_000,
        lastActivityAtMs: 1_700_100_000_000,
        messageCount: 2,
      });
      expect(sessions[0]!.messageBytes).toBeGreaterThan(0);
    }),
  );

  it.effect("returns an empty list when the database cannot be opened", () =>
    Effect.gen(function* () {
      const dir = yield* makeTempDir("t3code-devin-store-");
      const sessions = yield* DevinSessionStore.listSessions(`${dir}/missing/sessions.db`);
      expect(sessions).toEqual([]);
    }),
  );

  it.effect("reconstructs the canonical chain and drops non-chat roles", () =>
    Effect.gen(function* () {
      const dir = yield* makeTempDir("t3code-devin-store-");
      const dbPath = yield* createDevinDb({
        directory: dir,
        sessions: [
          {
            id: "forked",
            workingDirectory: "/work/forked",
            title: null,
            createdAt: 1_700_000_000,
            lastActivityAt: 1_700_000_100,
            // Canonical chain ends at node 3; node 4 is a fork branch.
            mainChainId: 3,
          },
        ],
        nodes: [
          {
            sessionId: "forked",
            nodeId: 1,
            chatMessage: chatMessage("user", "first prompt", "2023-11-14T22:13:20.000Z"),
            createdAt: 1_700_000_001,
          },
          {
            sessionId: "forked",
            nodeId: 2,
            parentNodeId: 1,
            chatMessage: chatMessage("assistant", [{ type: "text", text: "first answer" }]),
            createdAt: 1_700_000_002,
          },
          {
            sessionId: "forked",
            nodeId: 3,
            parentNodeId: 2,
            chatMessage: chatMessage("user", "follow up"),
            createdAt: 1_700_000_003,
          },
          {
            sessionId: "forked",
            nodeId: 4,
            parentNodeId: 1,
            chatMessage: chatMessage("assistant", "fork branch reply"),
            createdAt: 1_700_000_004,
          },
          {
            sessionId: "forked",
            nodeId: 5,
            parentNodeId: 3,
            chatMessage: chatMessage("system", "internal note"),
            createdAt: 1_700_000_005,
          },
        ],
      });

      const thread = yield* DevinSessionStore.readSessionThread(dbPath, "forked");

      expect(thread).not.toBeNull();
      expect(thread!.messages.map((message) => [message.role, message.text])).toEqual([
        ["user", "first prompt"],
        ["assistant", "first answer"],
        ["user", "follow up"],
      ]);
      // No title column: the first user prompt becomes the title.
      expect(thread!.title).toBe("first prompt");
      // The metadata timestamp wins over the node row's unix seconds.
      expect(thread!.messages[0]!.createdAt).toBe("2023-11-14T22:13:20.000Z");
      expect(thread!.createdAt).toBe("2023-11-14T22:13:20.000Z");
      expect(thread!.updatedAt).toBe("2023-11-14T22:15:00.000Z");
    }),
  );

  it.effect("returns null for hidden or message-less sessions", () =>
    Effect.gen(function* () {
      const dir = yield* makeTempDir("t3code-devin-store-");
      const dbPath = yield* createDevinDb({
        directory: dir,
        sessions: [
          {
            id: "hidden",
            workingDirectory: "/work/hidden",
            createdAt: 1_700_000_000,
            lastActivityAt: 1_700_000_100,
            hidden: true,
          },
          {
            id: "assistant-only",
            workingDirectory: "/work/none",
            createdAt: 1_700_000_000,
            lastActivityAt: 1_700_000_100,
          },
        ],
        nodes: [
          {
            sessionId: "hidden",
            nodeId: 1,
            chatMessage: chatMessage("user", "should not load"),
            createdAt: 1_700_000_001,
          },
          {
            sessionId: "assistant-only",
            nodeId: 1,
            chatMessage: chatMessage("assistant", "no user prompt"),
            createdAt: 1_700_000_001,
          },
        ],
      });

      expect(yield* DevinSessionStore.readSessionThread(dbPath, "hidden")).toBeNull();
      expect(yield* DevinSessionStore.readSessionThread(dbPath, "assistant-only")).toBeNull();
      expect(yield* DevinSessionStore.readSessionThread(dbPath, "missing")).toBeNull();
    }),
  );
});
