/**
 * DevinSessionStore - read-only access to the Devin CLI session database.
 *
 * `devin` and `devin acp` keep every local session in
 * `<data-dir>/sessions.db`: a `sessions` table carries the working directory,
 * title, model, and unix-second timestamps, and a `message_nodes` forest
 * holds one JSON chat message per node. Session forks turn the forest into a
 * tree; `sessions.main_chain_id` points at the leaf of the canonical chain,
 * so walking `parent_node_id` from it reconstructs the visible conversation.
 *
 * The database belongs to another process, so every read opens it lazily and
 * read-only; failures degrade to empty results just like unreadable Claude or
 * Codex transcripts do.
 *
 * @module project/DevinSessionStore
 */
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";

import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { expandHomePath } from "../pathExpansion.ts";

/** Cap on messages copied into a T3 thread, matching AgentSessionScanner. */
const MAX_IMPORTED_MESSAGES = 200;

export interface DevinSessionSummary {
  readonly sessionId: string;
  readonly workspaceRoot: string;
  readonly title: string | null;
  readonly model: string | null;
  readonly createdAtMs: number;
  readonly lastActivityAtMs: number;
  /** Count of user/assistant nodes; drives both display and change detection. */
  readonly messageCount: number;
  readonly messageBytes: number;
}

export interface DevinSessionThreadMessage {
  readonly role: "user" | "assistant";
  readonly text: string;
  readonly createdAt: string;
}

export interface DevinSessionThread {
  readonly sessionId: string;
  readonly workspaceRoot: string;
  readonly title: string;
  readonly model: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly createdAtMs: number;
  readonly lastActivityAtMs: number;
  readonly messageCount: number;
  readonly messageBytes: number;
  readonly messages: ReadonlyArray<DevinSessionThreadMessage>;
}

const DevinSessionRow = Schema.Struct({
  id: Schema.String,
  working_directory: Schema.String,
  title: Schema.NullOr(Schema.String),
  model: Schema.NullOr(Schema.String),
  created_at: Schema.Number,
  last_activity_at: Schema.Number,
  main_chain_id: Schema.optional(Schema.NullOr(Schema.Number)),
});

const DevinSessionStatsRow = Schema.Struct({
  message_count: Schema.Number,
  message_bytes: Schema.Number,
});

const DevinMessageNodeRow = Schema.Struct({
  node_id: Schema.Number,
  parent_node_id: Schema.NullOr(Schema.Number),
  chat_message: Schema.String,
  created_at: Schema.Number,
});

const DevinChatMessage = Schema.Struct({
  role: Schema.optional(Schema.String),
  content: Schema.optional(Schema.Unknown),
  metadata: Schema.optional(
    Schema.Struct({
      created_at: Schema.optional(Schema.String),
    }),
  ),
});

const decodeSessionRow = Schema.decodeUnknownSync(DevinSessionRow);
const decodeSessionStatsRow = Schema.decodeUnknownSync(DevinSessionStatsRow);
const decodeMessageNodeRow = Schema.decodeUnknownSync(DevinMessageNodeRow);
const decodeChatMessage = Schema.decodeUnknownOption(Schema.fromJsonString(DevinChatMessage));

const toIso = (unixSeconds: number) =>
  DateTime.formatIso(DateTime.makeUnsafe(Math.max(0, unixSeconds) * 1000));

function extractDevinText(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content
    .map((block) =>
      typeof block === "object" &&
      block !== null &&
      "text" in block &&
      typeof block.text === "string"
        ? block.text.trim()
        : "",
    )
    .filter((text) => text.length > 0)
    .join("\n");
}

/** Open the foreign database read-only for the body of `fn`. */
const withDatabase = <A>(
  dbPath: string,
  fn: (db: NodeSqlite.DatabaseSync) => A,
): Effect.Effect<Option.Option<A>> =>
  Effect.acquireUseRelease(
    Effect.try(() => new NodeSqlite.DatabaseSync(dbPath, { readOnly: true })),
    (db) => Effect.try(() => Option.some(fn(db))),
    (db) => Effect.sync(() => db.close()),
  ).pipe(
    Effect.catch((cause) =>
      Effect.logWarning("Could not read Devin session database", { dbPath, cause }).pipe(
        Effect.as(Option.none<A>()),
      ),
    ),
  );

/**
 * Every non-hidden session in one database. `working_directory` is returned
 * raw; callers normalize and check it still exists before offering it.
 */
export const listSessions = (dbPath: string): Effect.Effect<ReadonlyArray<DevinSessionSummary>> =>
  withDatabase(dbPath, (db) => {
    const rows = db
      .prepare(
        `SELECT
          s.id,
          s.working_directory,
          s.title,
          s.model,
          s.created_at,
          s.last_activity_at,
          (SELECT COUNT(*) FROM message_nodes m
            WHERE m.session_id = s.id
              AND json_extract(m.chat_message, '$.role') IN ('user', 'assistant')) AS message_count,
          (SELECT COALESCE(SUM(LENGTH(m.chat_message)), 0) FROM message_nodes m
            WHERE m.session_id = s.id) AS message_bytes
        FROM sessions s
        WHERE s.hidden = 0`,
      )
      .all();
    return rows.flatMap((row) => {
      try {
        const decoded = decodeSessionRow(row);
        const stats = decodeSessionStatsRow(row);
        if (decoded.working_directory.trim().length === 0) return [];
        return [
          {
            sessionId: decoded.id,
            workspaceRoot: decoded.working_directory,
            title: decoded.title,
            model: decoded.model,
            createdAtMs: decoded.created_at * 1000,
            lastActivityAtMs: decoded.last_activity_at * 1000,
            messageCount: stats.message_count,
            messageBytes: stats.message_bytes,
          } satisfies DevinSessionSummary,
        ];
      } catch {
        return [];
      }
    });
  }).pipe(Effect.map(Option.getOrElse((): ReadonlyArray<DevinSessionSummary> => [])));

/**
 * Reconstruct one session's visible conversation for history import. Only
 * user and assistant text is kept — tool calls, reasoning, and system context
 * stay behind, matching what the other importers retain.
 */
export const readSessionThread = (
  dbPath: string,
  sessionId: string,
): Effect.Effect<DevinSessionThread | null> =>
  withDatabase(dbPath, (db) => {
    const session = db
      .prepare(
        `SELECT id, working_directory, title, model, created_at, last_activity_at, main_chain_id,
          (SELECT COUNT(*) FROM message_nodes m
            WHERE m.session_id = s.id
              AND json_extract(m.chat_message, '$.role') IN ('user', 'assistant')) AS message_count,
          (SELECT COALESCE(SUM(LENGTH(m.chat_message)), 0) FROM message_nodes m
            WHERE m.session_id = s.id) AS message_bytes
        FROM sessions s WHERE s.id = ? AND s.hidden = 0`,
      )
      .get(sessionId);
    if (session === undefined) return null;
    const sessionRow = decodeSessionRow(session);
    const sessionStats = decodeSessionStatsRow(session);
    const nodeRows = db
      .prepare(
        `SELECT node_id, parent_node_id, chat_message, created_at
          FROM message_nodes WHERE session_id = ? ORDER BY node_id ASC`,
      )
      .all(sessionId)
      .flatMap((row) => {
        try {
          return [decodeMessageNodeRow(row)];
        } catch {
          return [];
        }
      });
    if (nodeRows.length === 0) return null;

    const byId = new Map(nodeRows.map((row) => [row.node_id, row]));
    // The canonical chain ends at main_chain_id; fall back to the newest node
    // for sessions the CLI closed before recording one.
    let leaf = sessionRow.main_chain_id ?? nodeRows[nodeRows.length - 1]!.node_id;
    if (!byId.has(leaf)) leaf = nodeRows[nodeRows.length - 1]!.node_id;
    const chain: typeof nodeRows = [];
    for (
      let cursor: number | null = leaf;
      cursor !== null && byId.has(cursor) && chain.length <= nodeRows.length;
    ) {
      const node: (typeof nodeRows)[number] | undefined = byId.get(cursor);
      if (node === undefined) break;
      chain.push(node);
      cursor = node.parent_node_id;
    }
    chain.reverse();

    const fallbackTimestamp = toIso(sessionRow.last_activity_at);
    const messages: Array<DevinSessionThreadMessage> = [];
    let firstUserMessage: DevinSessionThreadMessage | undefined;
    const retain = (message: DevinSessionThreadMessage) => {
      if (firstUserMessage === undefined && message.role === "user") {
        firstUserMessage = message;
      }
      messages.push(message);
      if (messages.length > MAX_IMPORTED_MESSAGES) messages.shift();
    };

    for (const node of chain) {
      const decoded = decodeChatMessage(node.chat_message);
      if (Option.isNone(decoded)) continue;
      const { role, content, metadata } = decoded.value;
      if (role !== "user" && role !== "assistant") continue;
      const text = extractDevinText(content);
      if (text.length === 0) continue;
      const createdAt =
        typeof metadata?.created_at === "string" && metadata.created_at.length > 0
          ? metadata.created_at
          : toIso(node.created_at);
      retain({ role, text, createdAt });
    }
    if (firstUserMessage === undefined) return null;
    const retained = messages.includes(firstUserMessage)
      ? messages
      : [firstUserMessage, ...messages.slice(-(MAX_IMPORTED_MESSAGES - 1))];

    const title =
      sessionRow.title?.trim() ||
      firstUserMessage.text.trim().split("\n")[0]?.slice(0, 100).trim() ||
      "Imported thread";
    return {
      sessionId: sessionRow.id,
      workspaceRoot: sessionRow.working_directory,
      title,
      model: sessionRow.model,
      createdAt: toIso(sessionRow.created_at),
      updatedAt: fallbackTimestamp,
      createdAtMs: sessionRow.created_at * 1000,
      lastActivityAtMs: sessionRow.last_activity_at * 1000,
      messageCount: sessionStats.message_count,
      messageBytes: sessionStats.message_bytes,
      messages: retained,
    } satisfies DevinSessionThread;
  }).pipe(Effect.map(Option.getOrElse(() => null)));

/**
 * Data directories a Devin instance may keep `sessions.db` in, newest layout
 * first. `homePath` (the provider's configured data directory) wins when set;
 * otherwise the platform default is used, with the pre-rename
 * `cognition/cli` directory as an additional candidate. Callers dedupe by
 * filesystem identity since migration links the two.
 */
export function resolveDevinDataDirs(input: {
  readonly homePath: string | undefined;
  readonly platform: NodeJS.Platform;
  readonly localAppData?: string | undefined;
}): ReadonlyArray<string> {
  const configured = input.homePath?.trim() ?? "";
  if (configured.length > 0) return [expandHomePath(configured)];
  const homeDir = NodeOS.homedir();
  const dirs: Array<string> = [];
  if (input.platform === "win32") {
    const localAppData =
      input.localAppData?.trim() || NodePath.win32.join(homeDir, "AppData", "Local");
    dirs.push(NodePath.win32.join(localAppData, "devin", "cli"));
  } else {
    dirs.push(NodePath.posix.join(homeDir, ".local", "share", "devin", "cli"));
    dirs.push(NodePath.posix.join(homeDir, ".local", "share", "cognition", "cli"));
  }
  return dirs;
}
