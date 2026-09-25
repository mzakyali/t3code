import { WS_METHODS } from "@t3tools/contracts";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
} from "@t3tools/client-runtime/state/runtime";

import { connectionAtomRuntime } from "../connection/runtime";

/**
 * Scan of Claude Code / Codex home directories on an environment, surfacing
 * project candidates for the welcome wizard's import step. The scan walks the
 * filesystem server-side, so results are cached briefly and refreshed when the
 * import step remounts.
 */
export const agentSessionScan = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "environment-data:agent-sessions:scan",
  tag: WS_METHODS.agentSessionsScan,
  staleTimeMs: 30_000,
  idleTtlMs: 5 * 60_000,
});

export const agentSessionImport = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:agent-sessions:import",
  tag: WS_METHODS.agentSessionsImport,
});

/**
 * Per-session Devin listing for the import picker. Keyed by projectId — pass
 * `undefined` for every session the server can find. Sessions are read from
 * the Devin CLI's database each call, so a short stale time is enough.
 */
export const agentSessionListThreads = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "environment-data:agent-sessions:list-threads",
  tag: WS_METHODS.agentSessionsListThreads,
  staleTimeMs: 15_000,
  idleTtlMs: 5 * 60_000,
});
