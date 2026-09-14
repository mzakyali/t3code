# Devin ACP Capability Parity Design

**Status:** Draft for written-spec review\
**Date:** 2026-09-07

## Goal

Bring Devin's MCP and richer ACP behavior to parity with the existing T3 provider experience across the server, shared contracts, client runtime, web, mobile, desktop, and remote connection modes.

The implementation must reuse T3's existing provider-neutral activity, pending-request, and subagent models. Devin-specific code belongs at the ACP adapter boundary.

## Current baseline

The branch already contains the basic Devin MCP path:

- `DevinAdapter` reads the thread-scoped `McpProviderSession` and passes the T3 MCP HTTP server to Devin ACP through `session/new` and `session/load`.
- `McpSessionRegistry` issues provider-scoped bearer credentials and revokes them with the provider session.
- `McpHttpServer` exposes the authenticated `/mcp` endpoint and the existing preview toolkit.
- `scripts/devin-mcp-smoke.ts` runs an opt-in live test against the real Devin CLI and verifies `tools/list`, `preview_status`, and one MCP-enabled turn.
- The shared runtime already represents MCP tool activity, pending requests, and subagent tasks for other providers.

The Task 2 skill work did not alter this MCP path. The next work is a parity and capability expansion, not a second MCP transport.

## Scope

The work is divided into four independently testable phases.

### Phase 1: MCP acceptance baseline

Harden and run the existing real Devin MCP smoke path. The acceptance path must prove:

1. Devin ACP starts with the T3 MCP server configuration.
2. The MCP endpoint accepts the provider-scoped bearer credential.
3. MCP initialization and `tools/list` succeed.
4. Devin calls `preview_status` exactly once through T3's MCP broker.
5. The assistant completes the turn with the expected response.
6. The MCP session and provider credential are revoked during cleanup.

This phase is opt-in and must not become part of the normal test suite because it requires a real authenticated Devin CLI and consumes a real provider turn.

### Phase 2: Resource parity

Support Devin resource content using the same representation and display behavior already used by other providers.

The adapter will first capture real Devin ACP/MCP payloads. It will then normalize supported resource content into the existing provider runtime item/tool data shape. Existing text, tool-call, and activity presentation remains intact when a resource block is absent or unsupported.

The default behavior is not a new Devin-specific resource card or resource browser. If the shared runtime cannot retain a required resource field, add an optional backward-compatible contract field and teach the existing web/mobile presentation layer to consume it for all providers that supply it.

Malformed or unsupported resource blocks are nonfatal. The surrounding turn and ordinary text/tool activity must remain usable, and bounded raw data may be retained for diagnostics.

### Phase 3: Elicitation parity

Wire Devin ACP elicitation requests into T3's existing pending-request flow.

- MCP-originated elicitation maps to the existing `mcp-elicitation` request kind and its current approval presentation when the payload has approval-style semantics.
- General ACP questions map to the existing user-input request model when the payload contains structured questions and answers.
- Web and mobile reuse the current pending request components and shared response commands.
- Responses are translated back to the native Devin ACP response shape by the adapter.
- Cancellation, interruption, session stop, model restart, connection failure, stale responses, and malformed requests settle safely without leaving a blocked turn.

No Devin-specific elicitation UI is introduced.

### Phase 4: Subagent parity

Capture and inspect Devin's native subagent or child-agent events. Only events that expose stable identity, lifecycle, and parent linkage are mapped into the existing `task.*` runtime events and `subagentRuntime` fold.

- Stable start, progress, and terminal signals become existing task activity.
- Repeated lifecycle signals are idempotent.
- Parent/child linkage is preserved when Devin supplies it.
- Incomplete or unknown events remain diagnostic data and do not create misleading Agents-panel entries.
- If the Devin CLI does not expose a stable child-agent stream, the provider reports the capability as unavailable rather than synthesizing subagents from ordinary tool calls.

No Devin-specific Agents panel is introduced.

## Non-goals

- Replacing the existing T3 MCP server or credential model.
- Creating a separate Devin-only contract family for events already represented by T3 contracts.
- Adding a new resource browser, resource card, elicitation dialog, or Agents panel.
- Changing MCP, ACP, or subagent behavior for other providers unless a narrowly scoped provider-neutral fix is required.
- Treating ordinary tool calls as subagent events without stable Devin identity data.
- Claiming support for a Devin capability that is not demonstrated by a real CLI payload or a protocol fixture derived from one.

## Architecture and data flow

```text
Devin ACP / MCP
      |
      v
DevinAdapter
  - ACP request handlers
  - Devin payload normalization
  - MCP credential/session wiring
      |
      v
ProviderRuntimeEvent
      |
      v
Server ingestion and projections
      |
      +--> client-runtime activity/pending-request/subagent folds
      |
      +--> Web existing work-log and request UI
      |
      +--> Mobile existing activity and request UI
```

`AcpSessionRuntime` remains a transport and protocol seam. It may gain provider-neutral hooks only when the same behavior is useful to more than Devin and can be expressed without provider conditionals.

The Devin adapter owns native method names, payload validation, lifecycle cleanup, and response conversion. The server's canonical event and request shapes remain the boundary shared by local, remote, relay, tunnel, desktop, web, and mobile clients.

## Compatibility, failure, and security rules

### Provider and client compatibility

- Existing optional contract fields remain optional so older clients can read newer activity safely.
- Existing web and mobile components remain the presentation path.
- Desktop inherits web behavior.
- Remote connections receive the same typed events as local connections.
- Other provider adapters remain unchanged unless a shared ACP/runtime improvement is proven necessary.

### Failure behavior

- The MCP smoke test reports clear setup, authentication, protocol, tool-call, and cleanup failures.
- Resource decode failures do not fail the surrounding turn.
- Elicitation failures become visible provider request failures and never leave a permanently pending request.
- Subagent events with insufficient identity are ignored for user-facing projections and retained only within bounded diagnostics.
- Session stop, interruption, model restart, and connection loss settle pending approvals and user inputs using the existing cleanup behavior.

### Security and performance

- Provider-scoped MCP bearer credentials remain hashed in the registry and are revoked when their provider session or thread ends.
- Logs never include bearer tokens, complete environment values, or complete user prompts.
- Native payloads and tool output are bounded before persistence or runtime emission.
- No discovery or probe runs once per ordinary turn.
- Live tests are opt-in and never run against the user's shared T3 home.

## Testing and acceptance

### Server and provider tests

- Devin ACP fixtures cover resource content, elicitation requests/responses, and every supported subagent event shape.
- Devin adapter tests prove normalization, response round trips, cleanup, stale-request handling, duplicate lifecycle handling, and unsupported-event behavior.
- MCP session registry and HTTP server tests continue to cover credential scope, authorization, tool listing, and revocation.
- Existing Devin skill, ACP, provider, registry, usage, and text-generation tests remain green.

### Contract and client-runtime tests

- Contract schemas decode new optional fields and reject unsafe malformed data.
- Provider runtime ingestion persists the canonical events correctly.
- Pending-request folds preserve the existing `mcp-elicitation` and user-input behavior.
- Subagent folds derive the same Agent-panel model used by other providers.

### Web and mobile tests

- Existing work-log components display Devin MCP/resource activity through the shared presentation path.
- Existing pending-request components render and resolve Devin elicitation without a Devin-specific branch.
- Existing Agents-panel components render mapped Devin subagents and ignore unsupported events.
- Web and mobile typechecks pass independently.

### Live acceptance

When the real Devin CLI supports the relevant capability, add an opt-in live probe for it. The existing smoke test remains the required baseline for Phase 1. Resource, elicitation, and subagent live tests must use real captured protocol behavior; fixtures alone cannot claim provider support.

### Final verification gates

Before a phase is considered complete:

- Focused tests for the changed server, contracts, client-runtime, web, and mobile paths pass.
- Relevant server, web, and mobile typechecks pass.
- `git diff --check` is clean and no conflict markers exist in source.
- The live Devin MCP smoke test passes when the local CLI is available.
- No unrelated provider behavior changes.
- Any unsupported Devin capability is reported explicitly.

## Rollout order

Land and verify each phase independently:

1. MCP smoke baseline.
2. Resource parity.
3. Elicitation parity.
4. Subagent parity or an explicit unsupported-capability result based on protocol evidence.

Each phase should produce a reviewable commit and a focused verification report before the next phase begins.
