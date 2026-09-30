import {
  CommandId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type OrchestrationReadModel,
  type OrchestrationSession,
  type OrchestrationThread,
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
});
