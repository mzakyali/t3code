import {
  CheckpointRef,
  CommandId,
  EventId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type OrchestrationReadModel,
  type OrchestrationSession,
  type OrchestrationThread,
  type OrchestrationThreadActivity,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { decideOrchestrationCommand } from "./decider.ts";

const NOW = "2026-01-01T00:00:00.000Z";
const threadId = ThreadId.make("thread-1");
const handoffModelSelection = {
  instanceId: ProviderInstanceId.make("claude"),
  model: "claude-opus-4-7",
};

function makeSession(
  status: OrchestrationSession["status"],
  activeTurnId: OrchestrationSession["activeTurnId"] = null,
): OrchestrationSession {
  return {
    threadId,
    status,
    providerName: "Codex",
    runtimeMode: "full-access",
    activeTurnId,
    lastError: null,
    updatedAt: NOW,
  };
}

function makeThread(overrides: Partial<OrchestrationThread> = {}): OrchestrationThread {
  return {
    id: threadId,
    projectId: ProjectId.make("project-1"),
    title: "Thread",
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    pullRequests: [],
    latestTurn: null,
    createdAt: NOW,
    updatedAt: NOW,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    snoozedUntil: null,
    snoozedAt: null,
    pinnedAt: null,
    deletedAt: null,
    messages: [],
    proposedPlans: [],
    activities: [],
    checkpoints: [],
    session: null,
    ...overrides,
  };
}

function makeReadModel(thread: OrchestrationThread | null): OrchestrationReadModel {
  return {
    snapshotSequence: 0,
    projects: [],
    threads: thread === null ? [] : [thread],
    updatedAt: NOW,
  };
}

const command = {
  type: "thread.provider.handoff" as const,
  commandId: CommandId.make("cmd-handoff"),
  threadId,
  modelSelection: handoffModelSelection,
  createdAt: NOW,
};

const completedTurn: OrchestrationThread["latestTurn"] = {
  turnId: TurnId.make("turn-1"),
  state: "completed",
  requestedAt: NOW,
  startedAt: NOW,
  completedAt: NOW,
  assistantMessageId: MessageId.make("assistant-1"),
};

function requestActivity(kind: string, requestId: string): OrchestrationThreadActivity {
  return {
    id: EventId.make(`activity-${requestId}-${kind}`),
    kind,
    summary: kind,
    tone: "approval",
    turnId: null,
    createdAt: NOW,
    payload: { requestId },
  };
}

it.layer(NodeServices.layer)("provider handoff decider", (it) => {
  it.effect("emits thread.provider-handoff-requested for a started, settled thread", () =>
    Effect.gen(function* () {
      const result = yield* decideOrchestrationCommand({
        command,
        readModel: makeReadModel(
          makeThread({
            latestTurn: completedTurn,
            session: makeSession("ready"),
          }),
        ),
      });
      const events = Array.isArray(result) ? result : [result];
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        type: "thread.provider-handoff-requested",
        aggregateKind: "thread",
        aggregateId: threadId,
        occurredAt: NOW,
        commandId: command.commandId,
        payload: {
          threadId,
          modelSelection: handoffModelSelection,
        },
      });
    }),
  );

  it.effect("emits for a started thread with no live session", () =>
    Effect.gen(function* () {
      const result = yield* decideOrchestrationCommand({
        command,
        readModel: makeReadModel(makeThread({ latestTurn: completedTurn })),
      });
      const events = Array.isArray(result) ? result : [result];
      expect(events.map((event) => event.type)).toEqual(["thread.provider-handoff-requested"]);
    }),
  );

  it.effect("rejects when the thread does not exist", () =>
    Effect.gen(function* () {
      const error = yield* decideOrchestrationCommand({
        command,
        readModel: makeReadModel(null),
      }).pipe(Effect.flip);
      expect(error).toMatchObject({
        _tag: "OrchestrationCommandInvariantError",
        commandType: "thread.provider.handoff",
      });
    }),
  );

  it.effect("rejects when the thread has not started", () =>
    Effect.gen(function* () {
      const error = yield* decideOrchestrationCommand({
        command,
        readModel: makeReadModel(makeThread()),
      }).pipe(Effect.flip);
      expect(error).toMatchObject({
        _tag: "OrchestrationCommandInvariantError",
        commandType: "thread.provider.handoff",
      });
    }),
  );

  it.effect("rejects while a turn is in flight or the session is coming alive", () =>
    Effect.gen(function* () {
      for (const session of [
        makeSession("ready", TurnId.make("turn-active")),
        makeSession("running"),
        makeSession("starting"),
      ]) {
        const error = yield* decideOrchestrationCommand({
          command,
          readModel: makeReadModel(makeThread({ latestTurn: completedTurn, session })),
        }).pipe(Effect.flip);
        expect(error).toMatchObject({
          _tag: "OrchestrationCommandInvariantError",
          commandType: "thread.provider.handoff",
        });
      }
    }),
  );

  it.effect("emits between turns on an interrupted or stopped session", () =>
    Effect.gen(function* () {
      for (const status of ["interrupted", "stopped"] as const) {
        const result = yield* decideOrchestrationCommand({
          command,
          readModel: makeReadModel(
            makeThread({ latestTurn: completedTurn, session: makeSession(status) }),
          ),
        });
        const events = Array.isArray(result) ? result : [result];
        expect(events.map((event) => event.type)).toEqual(["thread.provider-handoff-requested"]);
      }
    }),
  );

  it.effect("rejects while an approval or user-input request is still open", () =>
    Effect.gen(function* () {
      for (const kind of ["approval.requested", "user-input.requested"]) {
        const error = yield* decideOrchestrationCommand({
          command,
          readModel: makeReadModel(
            makeThread({
              latestTurn: completedTurn,
              session: makeSession("ready"),
              activities: [requestActivity(kind, `req-${kind}`)],
            }),
          ),
        }).pipe(Effect.flip);
        expect(error).toMatchObject({
          _tag: "OrchestrationCommandInvariantError",
          commandType: "thread.provider.handoff",
          detail: expect.stringContaining("pending approval or user-input request"),
        });
      }
    }),
  );

  it.effect("emits once the pending request is resolved", () =>
    Effect.gen(function* () {
      const result = yield* decideOrchestrationCommand({
        command,
        readModel: makeReadModel(
          makeThread({
            latestTurn: completedTurn,
            session: makeSession("ready"),
            activities: [
              requestActivity("approval.requested", "req-1"),
              {
                ...requestActivity("approval.resolved", "req-1"),
                id: EventId.make("activity-req-1-resolved"),
              },
            ],
          }),
        ),
      });
      const events = Array.isArray(result) ? result : [result];
      expect(events.map((event) => event.type)).toEqual(["thread.provider-handoff-requested"]);
    }),
  );

  it.effect("rejects while a turn start is queued behind an unanswered message", () =>
    Effect.gen(function* () {
      const queuedMessage: OrchestrationThread["messages"][number] = {
        id: MessageId.make("message-queued"),
        role: "user",
        text: "Continue",
        turnId: null,
        streaming: false,
        createdAt: NOW,
        updatedAt: NOW,
      };
      // The last turn finished before the message arrived, so the message
      // reads as a queued turn start inside the adoption window.
      const error = yield* decideOrchestrationCommand({
        command,
        readModel: makeReadModel(
          makeThread({
            latestTurn: {
              ...completedTurn,
              requestedAt: "2025-12-31T23:00:00.000Z",
              startedAt: "2025-12-31T23:00:01.000Z",
              completedAt: "2025-12-31T23:00:02.000Z",
            },
            session: makeSession("ready"),
            messages: [queuedMessage],
          }),
        ),
      }).pipe(Effect.flip);
      expect(error).toMatchObject({
        _tag: "OrchestrationCommandInvariantError",
        commandType: "thread.provider.handoff",
        detail: expect.stringContaining("queued turn start"),
      });
    }),
  );
});

function checkpoint(
  turnCount: number,
  completedAt: string,
): OrchestrationThread["checkpoints"][number] {
  return {
    turnId: TurnId.make(`turn-${turnCount}`),
    checkpointTurnCount: turnCount,
    checkpointRef: CheckpointRef.make(`refs/t3/checkpoints/${threadId}/turn/${turnCount}`),
    status: "ready",
    files: [],
    assistantMessageId: null,
    completedAt,
  };
}

function handoffActivity(
  createdAt: string,
  id = `handoff-${createdAt}`,
  turnCount?: number,
): OrchestrationThreadActivity {
  return {
    id: EventId.make(id),
    kind: "provider.handoff",
    summary: "Handed off to claude",
    tone: "info",
    turnId: null,
    createdAt,
    payload: {
      fromProvider: "codex",
      fromInstanceId: "codex",
      toInstanceId: "claude",
      brief: "carry on",
      degraded: false,
      createdAt,
      ...(turnCount === undefined ? {} : { turnCount }),
    },
  };
}

// Two pre-handoff turns (checkpoints 1-2), the handoff card, then two turns
// on the destination provider (checkpoints 3-4).
const handedOffThread = makeThread({
  latestTurn: {
    turnId: TurnId.make("turn-4"),
    state: "completed",
    requestedAt: "2026-01-01T00:00:04.000Z",
    startedAt: "2026-01-01T00:00:04.000Z",
    completedAt: "2026-01-01T00:00:05.000Z",
    assistantMessageId: null,
  },
  checkpoints: [
    checkpoint(1, "2026-01-01T00:00:01.000Z"),
    checkpoint(2, "2026-01-01T00:00:02.000Z"),
    checkpoint(3, "2026-01-01T00:00:04.000Z"),
    checkpoint(4, "2026-01-01T00:00:05.000Z"),
  ],
  activities: [handoffActivity("2026-01-01T00:00:03.000Z")],
});

it.layer(NodeServices.layer)("conversation revert across provider handoff", (it) => {
  const revertCommand = (
    turnCount: number,
    type: "thread.conversation.revert" | "thread.checkpoint.revert" = "thread.conversation.revert",
  ) => ({
    type,
    commandId: CommandId.make(`cmd-${type}-${turnCount}`),
    threadId,
    turnCount,
    createdAt: NOW,
  });

  // Both revert kinds roll back the bound provider's session — the checkpoint
  // variant just restores files on top — so both are gated the same way.
  it.effect("rejects a revert that lands on or before the last provider handoff", () =>
    Effect.gen(function* () {
      for (const type of ["thread.conversation.revert", "thread.checkpoint.revert"] as const) {
        for (const turnCount of [0, 1, 2]) {
          const error = yield* decideOrchestrationCommand({
            command: revertCommand(turnCount, type),
            readModel: makeReadModel(handedOffThread),
          }).pipe(Effect.flip);
          expect(error).toMatchObject({
            _tag: "OrchestrationCommandInvariantError",
            commandType: type,
          });
        }
      }
    }),
  );

  it.effect("emits for a revert that stays on the destination provider's turns", () =>
    Effect.gen(function* () {
      const conversationResult = yield* decideOrchestrationCommand({
        command: revertCommand(3),
        readModel: makeReadModel(handedOffThread),
      });
      const conversationEvents = Array.isArray(conversationResult)
        ? conversationResult
        : [conversationResult];
      expect(conversationEvents[0]).toMatchObject({
        type: "thread.checkpoint-revert-requested",
        payload: {
          threadId,
          turnCount: 3,
          restoreFiles: false,
        },
      });

      const checkpointResult = yield* decideOrchestrationCommand({
        command: revertCommand(3, "thread.checkpoint.revert"),
        readModel: makeReadModel(handedOffThread),
      });
      const checkpointEvents = Array.isArray(checkpointResult)
        ? checkpointResult
        : [checkpointResult];
      expect(checkpointEvents).toHaveLength(1);
      expect(checkpointEvents[0]).toMatchObject({
        type: "thread.checkpoint-revert-requested",
        payload: { threadId, turnCount: 3 },
      });
      expect(checkpointEvents[0]?.payload).not.toHaveProperty("restoreFiles");
    }),
  );

  it.effect("emits when the thread has no provider handoff activity", () =>
    Effect.gen(function* () {
      const result = yield* decideOrchestrationCommand({
        command: revertCommand(0),
        readModel: makeReadModel(
          makeThread({
            latestTurn: completedTurn,
            checkpoints: [checkpoint(1, "2026-01-01T00:00:01.000Z")],
          }),
        ),
      });
      const events = Array.isArray(result) ? result : [result];
      expect(events.map((event) => event.type)).toEqual(["thread.checkpoint-revert-requested"]);
    }),
  );

  it.effect("ignores a failed handoff when locating the boundary", () =>
    Effect.gen(function* () {
      const failedHandoff: OrchestrationThreadActivity = {
        ...handoffActivity("2026-01-01T00:00:03.000Z"),
        kind: "provider.handoff.failed",
      };
      const result = yield* decideOrchestrationCommand({
        command: revertCommand(0),
        readModel: makeReadModel(
          makeThread({
            latestTurn: completedTurn,
            checkpoints: [
              checkpoint(1, "2026-01-01T00:00:01.000Z"),
              checkpoint(2, "2026-01-01T00:00:02.000Z"),
            ],
            activities: [failedHandoff],
          }),
        ),
      });
      const events = Array.isArray(result) ? result : [result];
      expect(events.map((event) => event.type)).toEqual(["thread.checkpoint-revert-requested"]);
    }),
  );

  it.effect("gates against the most recent handoff when several exist", () =>
    Effect.gen(function* () {
      const thread = makeThread({
        latestTurn: {
          turnId: TurnId.make("turn-6"),
          state: "completed",
          requestedAt: "2026-01-01T00:00:08.000Z",
          startedAt: "2026-01-01T00:00:08.000Z",
          completedAt: "2026-01-01T00:00:09.000Z",
          assistantMessageId: null,
        },
        checkpoints: [
          checkpoint(1, "2026-01-01T00:00:01.000Z"),
          checkpoint(2, "2026-01-01T00:00:02.000Z"),
          checkpoint(3, "2026-01-01T00:00:04.000Z"),
          checkpoint(4, "2026-01-01T00:00:05.000Z"),
          checkpoint(5, "2026-01-01T00:00:07.000Z"),
          checkpoint(6, "2026-01-01T00:00:09.000Z"),
        ],
        activities: [
          handoffActivity("2026-01-01T00:00:03.000Z", "handoff-1"),
          handoffActivity("2026-01-01T00:00:06.000Z", "handoff-2"),
        ],
      });
      const error = yield* decideOrchestrationCommand({
        command: revertCommand(4),
        readModel: makeReadModel(thread),
      }).pipe(Effect.flip);
      expect(error).toMatchObject({
        _tag: "OrchestrationCommandInvariantError",
        commandType: "thread.conversation.revert",
      });
      const result = yield* decideOrchestrationCommand({
        command: revertCommand(5),
        readModel: makeReadModel(thread),
      });
      const events = Array.isArray(result) ? result : [result];
      expect(events.map((event) => event.type)).toEqual(["thread.checkpoint-revert-requested"]);
    }),
  );

  // New handoff records stamp the boundary on the payload so the gate keeps
  // working after the projector's checkpoint window evicts every pre-handoff
  // checkpoint.
  it.effect("reads the boundary from the activity payload when its checkpoints are evicted", () =>
    Effect.gen(function* () {
      const thread = makeThread({
        latestTurn: handedOffThread.latestTurn,
        checkpoints: [
          checkpoint(505, "2026-01-02T00:00:00.000Z"),
          checkpoint(506, "2026-01-02T00:00:01.000Z"),
        ],
        activities: [handoffActivity("2026-01-01T00:00:03.000Z", "handoff-1", 2)],
      });
      const error = yield* decideOrchestrationCommand({
        command: revertCommand(2),
        readModel: makeReadModel(thread),
      }).pipe(Effect.flip);
      expect(error).toMatchObject({
        _tag: "OrchestrationCommandInvariantError",
        commandType: "thread.conversation.revert",
        detail: expect.stringContaining("turn 2"),
      });
      const result = yield* decideOrchestrationCommand({
        command: revertCommand(3),
        readModel: makeReadModel(thread),
      });
      const events = Array.isArray(result) ? result : [result];
      expect(events.map((event) => event.type)).toEqual(["thread.checkpoint-revert-requested"]);
    }),
  );

  it.effect("falls back to the checkpoint join when the payload turnCount is malformed", () =>
    Effect.gen(function* () {
      for (const turnCount of ["2", -1, 2.5] as const) {
        const activity: OrchestrationThreadActivity = {
          ...handoffActivity("2026-01-01T00:00:03.000Z"),
          payload: { turnCount },
        };
        const thread = {
          ...handedOffThread,
          activities: [activity],
        };
        const error = yield* decideOrchestrationCommand({
          command: revertCommand(2),
          readModel: makeReadModel(thread),
        }).pipe(Effect.flip);
        expect(error).toMatchObject({
          _tag: "OrchestrationCommandInvariantError",
          commandType: "thread.conversation.revert",
          detail: expect.stringContaining("turn 2"),
        });
      }
    }),
  );

  // On restart the command read model carries no activities or checkpoints;
  // the engine resolves the boundary straight from the projection tables and
  // injects it here.
  it.effect("enforces an injected durable boundary without any snapshot state", () =>
    Effect.gen(function* () {
      const thread = makeThread({ latestTurn: handedOffThread.latestTurn });
      const error = yield* decideOrchestrationCommand({
        command: revertCommand(2),
        readModel: makeReadModel(thread),
        providerHandoffBoundary: 2,
      }).pipe(Effect.flip);
      expect(error).toMatchObject({
        _tag: "OrchestrationCommandInvariantError",
        commandType: "thread.conversation.revert",
        detail: expect.stringContaining("turn 2"),
      });
      const result = yield* decideOrchestrationCommand({
        command: revertCommand(3),
        readModel: makeReadModel(thread),
        providerHandoffBoundary: 2,
      });
      const events = Array.isArray(result) ? result : [result];
      expect(events.map((event) => event.type)).toEqual(["thread.checkpoint-revert-requested"]);
    }),
  );

  it.effect("keeps the stricter boundary when the injected and snapshot values disagree", () =>
    Effect.gen(function* () {
      // Snapshot says turn 2, durable projection says turn 4 — a late
      // source-era checkpoint landed after the activity was written. The
      // gate stays at the higher (safer) boundary.
      const error = yield* decideOrchestrationCommand({
        command: revertCommand(3),
        readModel: makeReadModel(handedOffThread),
        providerHandoffBoundary: 4,
      }).pipe(Effect.flip);
      expect(error).toMatchObject({
        _tag: "OrchestrationCommandInvariantError",
        commandType: "thread.conversation.revert",
        detail: expect.stringContaining("turn 4"),
      });
    }),
  );
});
