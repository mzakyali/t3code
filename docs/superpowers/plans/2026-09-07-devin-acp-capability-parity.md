# Devin ACP Capability Parity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bring Devin's MCP and richer ACP behavior to the same provider-neutral experience already available in T3 Code: verified MCP connectivity, resource content preservation, elicitation requests and responses, and child-agent lifecycle activity across the server, shared runtime, web, desktop, mobile, and remote connections.

**Architecture:** Keep Devin-specific protocol translation at the `DevinAdapter`/ACP boundary. Convert only observed Devin ACP/MCP payloads into the existing `ProviderRuntimeEvent` vocabulary, then let the existing ingestion, client-runtime folds, web components, desktop wrapper, and mobile activity model render them. Add a shared contract field only when the current runtime cannot retain required information. Do not create Devin-specific UI or invent a protocol event shape that has not been captured from the real CLI or typed ACP dependency.

**Tech Stack:** TypeScript, Effect, ACP JSON-RPC, MCP over the existing authenticated T3 HTTP server, `ProviderRuntimeEvent` contracts, Vitest via `vp test run`, `tsgo`/TypeScript typechecks, React web, React Native mobile, and the existing opt-in Devin CLI smoke harness.

## Global Constraints

- Preserve the current Devin implementation, upstream compatibility, skill discovery/dispatch, and all untracked user files.
- Keep Devin-specific behavior in `apps/server/src/provider/Layers/DevinAdapter.ts` and small ACP support modules. Do not modify unrelated provider adapters.
- Reuse existing `ProviderRuntimeEvent`, `request.opened`/`request.resolved`, `user-input.*`, and `task.*` contracts before considering a contract change.
- Do not add a Devin-specific resource card, approval panel, elicitation screen, or Agents panel. Existing web and mobile components must consume the same provider-neutral events as other providers.
- Treat the real Devin CLI as an opt-in acceptance dependency. Normal unit, integration, typecheck, and CI commands must run without Devin credentials or an installed Devin binary.
- Capture and redact protocol evidence before writing a parser. Do not commit tokens, authorization headers, prompts, workspace secrets, absolute user paths, or unbounded tool output.
- Use bounded subprocess output and bounded protocol payloads. Malformed or unsupported optional content must not fail an otherwise valid turn.
- Use typed receipts, `Deferred`, and event completion signals in tests. Do not add sleeps, polling loops, or timing-based assertions.
- Test local, remote/relay, tunnel, web, desktop-wrapper, and mobile compatibility through the existing typed event path. Do not bake origins into the web bundle.
- Run focused tests and package-scoped typechecks only. Do not run `vp check`, recursive tests, or recursive typechecks unless a maintainer explicitly requests them.

---

## Repository Map and Existing Seams

Use these files as the starting map before changing code:

| Area                                                                                                | Existing responsibility                                                                                                                        | Planned use                                                                                                                                         |
| --------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/server/src/provider/Layers/DevinAdapter.ts`                                                   | Owns Devin ACP session creation, MCP session wiring, notification translation, pending requests, turns, stop/restart, and user-input responses | Register Devin elicitation handling, normalize observed resource/child-agent payloads, and preserve cleanup semantics                               |
| `apps/server/src/provider/acp/AcpSessionRuntime.ts`                                                 | Provider-neutral ACP runtime handlers, including `handleElicitation`, permission handling, session updates, and file operations                | Reuse its typed handler interfaces; change it only if a genuinely shared hook is required by more than Devin                                        |
| `apps/server/src/provider/acp/AcpRuntimeModel.ts`                                                   | Parses ACP session updates into provider-neutral model events and retains tool-call data                                                       | Verify whether resource content and child-agent data are already retained; add the smallest shared parser change only when evidence shows data loss |
| `apps/server/src/provider/acp/AcpCoreRuntimeEvents.ts`                                              | Converts ACP model events into canonical runtime events such as tool calls, requests, content, and usage                                       | Add provider-neutral task/request helpers only when existing constructors cannot express an observed Devin event                                    |
| `apps/server/src/provider/acp/DevinAcpCliProbe.test.ts`                                             | Opt-in real CLI probe that starts the authenticated MCP server, checks `tools/list`, invokes `preview_status`, and verifies one turn           | Phase 1 acceptance gate and sanitized evidence capture for later phases                                                                             |
| `scripts/devin-mcp-smoke.ts`                                                                        | Runs the real Devin MCP smoke test with explicit opt-in environment                                                                            | Keep the live test isolated and runnable by one documented command                                                                                  |
| `packages/contracts/src/providerRuntime.ts`                                                         | Typed canonical runtime events for requests, user input, tools, content, usage, and tasks                                                      | Reuse existing schemas; add optional fields only if resource/elicitation/subagent evidence cannot fit existing data                                 |
| `packages/contracts/src/orchestration.ts`                                                           | Provider request kinds and user-input answer types                                                                                             | Reuse `mcp-elicitation`, `ProviderUserInputAnswers`, and existing stop/restart request behavior                                                     |
| `apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts`                                  | Persists canonical events and derives pending request state                                                                                    | Verify new Devin events are ingested identically to other providers                                                                                 |
| `packages/client-runtime/src/pendingRequests.ts`                                                    | Folds request events into shared pending approval/user-input state                                                                             | Confirm Devin elicitation uses existing request kinds and stale-resolution rules                                                                    |
| `packages/client-runtime/src/state/subagentRuntime.ts`                                              | Folds `task.*` events into the shared child-agent model                                                                                        | Confirm Devin child-agent lifecycle uses existing task identity/linkage rules                                                                       |
| `apps/web/src/session-logic.ts` and `apps/web/src/components/chat/ComposerPendingApprovalPanel.tsx` | Web activity and pending request presentation                                                                                                  | Add regression coverage only; reuse existing branches                                                                                               |
| `apps/mobile/src/lib/threadActivity.ts`                                                             | Mobile activity projection and MCP/tool presentation                                                                                           | Add regression coverage only; reuse existing activity types                                                                                         |
| `docs/internals/providers.md` and `docs/user/providers-devin.md`                                    | Maintainer/provider behavior and user setup guidance                                                                                           | Update claims only after a capability is verified                                                                                                   |

## Dependency Order

1. Verify the existing MCP smoke path and establish the live acceptance gate.
2. Capture and implement resource preservation using real payload evidence.
3. Capture, normalize, and wire elicitation through existing pending-request flows.
4. Capture and wire stable child-agent events through existing `task.*`/subagent flows.
5. Run cross-surface verification and update only the documentation made inaccurate by the shipped behavior.

Each phase must remain independently reviewable. If the real Devin CLI does not expose a capability, record that result as an explicit unsupported outcome and do not synthesize events to make the tests appear to pass.

---

## Phase 1: Establish the MCP Acceptance Gate

### Task 1: Verify the existing real Devin MCP smoke path

**Files:**

- Inspect `apps/server/src/provider/acp/DevinAcpCliProbe.test.ts`.
- Inspect `scripts/devin-mcp-smoke.ts`.
- Inspect the public APIs in `apps/server/src/provider/Layers/McpSessionRegistry.ts`, `apps/server/src/provider/Layers/McpHttpServer.ts`, and `apps/server/src/provider/Layers/PreviewAutomationBroker.ts`.

**Interfaces to preserve:**

- `McpProviderSession` passed to `makeDevinAcpRuntime`.
- Authenticated `/mcp` JSON-RPC `initialize` and `tools/list` calls.
- The existing `preview_status` broker request and `turn.completed` receipt.
- Provider-scoped bearer credential issuance and revocation.

**Steps:**

- [ ] Run `vp run test:devin-smoke` with a real authenticated Devin CLI and confirm the existing probe reaches `initialize`, `tools/list`, exactly one `preview_status`, and the exact assistant marker.
- [ ] Run `vp test run apps/server/src/provider/acp/DevinAcpCliProbe.test.ts` without `T3_DEVIN_MCP_SMOKE=1` and confirm the live test is skipped rather than attempting to use shared credentials.
- [ ] Review the test finalizer and verify that the MCP provider session, HTTP server, preview broker, temporary workspace, and adapter event stream are all closed through their public cleanup APIs.
- [ ] If cleanup is not asserted, add one focused assertion using the registry's exported post-revocation lookup API; keep the assertion in `DevinAcpCliProbe.test.ts` and do not inspect private refs.
- [ ] Run `git diff --check` and `vp test run apps/server/src/provider/acp/DevinAcpCliProbe.test.ts` after any assertion change.
- [ ] Record the live command/result in the implementation handoff. If no Devin binary or credentials are available, record the exact skipped command and continue with deterministic fixture tests; do not weaken the opt-in guard.
- [ ] Commit only a required smoke-test cleanup/assertion change as `test(devin): harden MCP smoke cleanup`; if the existing gate already covers the behavior, leave source unchanged and do not create a no-op commit.

**Acceptance:** The existing MCP path is a repeatable, isolated acceptance gate: authenticated MCP startup works, `tools/list` includes `preview_status`, one real turn performs one preview call, the response is observed, and cleanup/revocation completes without touching `C:\Users\user\.t3`.

### Task 2: Add a sanitized ACP capture fixture for optional content

**Files:**

- Modify `apps/server/src/provider/acp/DevinAcpCliProbe.test.ts` only for test-local capture.
- Add `apps/server/src/provider/acp/DevinOptionalContentFixtures.test.ts` for redacted fixture constants and deterministic assertions.

**Interfaces to preserve:**

- Existing ACP `session/update` request log and `AcpRuntimeModel` input shape.
- Existing test-only request receipt/logging mechanism.
- No production logging of protocol payloads.

**Steps:**

- [ ] Add an opt-in test-only capture switch that stores bounded, redacted ACP update objects in memory and emits them only when the live probe fails or an explicit capture flag is set.
- [ ] Redact authorization headers, session credentials, prompt text, workspace paths, environment values, raw blobs, and any field exceeding the existing bounded capture size before a fixture is written.
- [ ] Run the live smoke command once with capture enabled and classify each observed optional block as ordinary text, resource link, embedded resource, elicitation, child-agent update, or unsupported data.
- [ ] Add only the smallest sanitized fixture that demonstrates each block actually emitted by the installed Devin CLI; keep ordinary MCP tool results in the existing smoke test.
- [ ] Add deterministic tests proving redaction and size bounds before using the fixture in a parser test.
- [ ] Run `vp test run apps/server/src/provider/acp/DevinOptionalContentFixtures.test.ts apps/server/src/provider/acp/DevinAcpCliProbe.test.ts`.
- [ ] Commit the fixture/capture change as `test(devin): capture sanitized ACP capability fixtures`.

**Acceptance:** Later phases have a reviewable, sanitized payload sample or an explicit “not emitted by this Devin CLI” result. No secret, prompt, credential, or unbounded raw payload is stored or logged.

---

## Phase 2: Resource Parity

### Task 3: Add a pure resource normalizer from observed ACP/MCP content

**Files:**

- Add `apps/server/src/provider/acp/DevinResourceSupport.ts`.
- Add `apps/server/src/provider/acp/DevinResourceSupport.test.ts`.
- Use the sanitized fixtures from Task 2.

**Interfaces:**

Define a small internal result that fits the existing `AcpToolCallState.data` channel:

```ts
type DevinResourceContent = {
  readonly uri: string;
  readonly name?: string;
  readonly description?: string;
  readonly mimeType?: string;
  readonly text?: string;
};

type DevinResourceNormalization =
  | { readonly kind: "resource"; readonly resource: DevinResourceContent }
  | { readonly kind: "unsupported"; readonly reason: "invalid" | "oversized" | "binary" };
```

Use the actual field names and discriminator values from the captured Devin/ACP payload. The normalizer must accept resource links and embedded textual resources only when they match the observed shape; it must not guess at undocumented fields.

**Steps:**

- [ ] Write fixture tests for one observed resource link, one observed embedded text resource, malformed resource content, missing URI, oversized text, and a binary/blob resource.
- [ ] Run `vp test run apps/server/src/provider/acp/DevinResourceSupport.test.ts` and confirm the new tests fail before the normalizer exists.
- [ ] Implement `normalizeDevinResourceContent` as a pure bounded function with no Effect services, filesystem reads, network calls, logging, or prompt access.
- [ ] Preserve URI, name, description, MIME type, and bounded text only when present; represent binary content as `unsupported` without decoding or logging it.
- [ ] Ensure invalid optional resource content returns a nonfatal result that leaves the surrounding tool call usable.
- [ ] Run `vp test run apps/server/src/provider/acp/DevinResourceSupport.test.ts` and `git diff --check`.
- [ ] Commit as `feat(devin): normalize ACP resource content`.

**Acceptance:** The normalizer is deterministic, bounded, fixture-backed, and cannot turn malformed optional content into a failed Devin turn.

### Task 4: Preserve normalized resources at the server runtime boundary

**Files:**

- Modify `apps/server/src/provider/acp/AcpRuntimeModel.ts` only if its current parser drops the captured resource block.
- Modify `apps/server/src/provider/acp/AcpRuntimeModel.test.ts` for any shared parser regression.
- Modify `apps/server/src/provider/Layers/DevinAdapter.ts` to apply the Devin normalizer at the adapter boundary.
- Modify `apps/server/src/provider/Layers/DevinAdapter.test.ts` with a Devin-specific integration test.
- Modify `apps/server/src/provider/acp/AcpCoreRuntimeEvents.ts` only if the existing tool-call event constructor cannot carry the normalized `data` value.

**Interfaces:**

- Keep resource metadata inside the existing tool/item `data` object when that object already crosses the wire.
- Reuse `makeAcpToolCallEvent` and the existing `item.updated`/`item.completed` event shape.
- Do not add a required field to `packages/contracts/src/providerRuntime.ts`.

**Steps:**

- [ ] Add a failing Devin adapter test that feeds the sanitized resource update through the ACP notification path and asserts the emitted canonical tool/item event retains `data.resource` with its URI and bounded metadata.
- [ ] Run `vp test run apps/server/src/provider/Layers/DevinAdapter.test.ts` to establish the failing assertion.
- [ ] Trace the captured block through `AcpRuntimeModel` and `makeAcpToolCallEvent`; if `AcpToolCallState.data` already preserves it, change only `DevinAdapter` and tests; otherwise add the smallest provider-neutral preservation change in `AcpRuntimeModel`.
- [ ] Ensure ordinary text, ordinary tool calls, and malformed resources continue through their existing paths unchanged.
- [ ] Ensure resource data is bounded before it enters a runtime event and is never written to logs.
- [ ] Run `vp test run apps/server/src/provider/Layers/DevinAdapter.test.ts apps/server/src/provider/acp/AcpRuntimeModel.test.ts apps/server/src/provider/acp/DevinResourceSupport.test.ts`.
- [ ] Commit as `feat(devin): preserve normalized ACP resources`.

**Acceptance:** An observed Devin resource reaches the existing provider-runtime tool activity with bounded data; ordinary turns and malformed optional blocks retain their prior behavior.

### Task 5: Verify resource rendering on web, desktop, mobile, and remote paths

**Files:**

- Inspect and test `packages/client-runtime/src/work-log/presentation.test.ts` and `packages/client-runtime/src/work-log/toolPresentation.test.ts`.
- Modify `apps/web/src/session-logic.test.ts` only if a regression test is needed.
- Modify `apps/mobile/src/lib/threadActivity.test.ts` only if a regression test is needed.
- Modify `apps/web/src/components/chat/*` or mobile production code only if the existing generic tool activity demonstrably drops the normalized resource; keep any field optional and provider-neutral.
- Add a contract test only if the existing `ProviderRuntimeEvent` schema rejects the optional resource data.

**Interfaces:**

- Web and mobile consume the same persisted/runtime item data.
- Desktop remains covered by the web bundle and existing Electron wrapper path.
- Remote and tunnel clients receive the same typed WebSocket event; no origin changes.

**Steps:**

- [ ] Add a client-runtime fixture containing the canonical Devin tool event from Task 4 and assert the existing activity fold does not discard `data.resource` or crash on it.
- [ ] Add a web regression assertion in the existing session-logic/activity test if web-specific normalization is present.
- [ ] Add a mobile regression assertion in `apps/mobile/src/lib/threadActivity.test.ts` if mobile-specific normalization is present.
- [ ] Run `vp test run packages/client-runtime/src/work-log/presentation.test.ts packages/client-runtime/src/work-log/toolPresentation.test.ts apps/web/src/session-logic.test.ts apps/mobile/src/lib/threadActivity.test.ts` with only the files that received the regression assertions.
- [ ] Run `vp run --filter @t3tools/web typecheck` and `vp run --filter @t3tools/mobile typecheck`.
- [ ] Confirm no Devin-specific component, WebSocket field, or contract requirement was added when the generic path already retained the data.
- [ ] Commit any required provider-neutral client fix as `fix(client): retain ACP resource activity`.

**Acceptance:** The same canonical event can be folded by client-runtime, rendered by web/desktop, and projected by mobile without a provider-specific UI branch. Remote delivery uses the unchanged typed event path.

---

## Phase 3: Elicitation Parity

### Task 6: Normalize observed Devin elicitation requests and responses

**Files:**

- Add `apps/server/src/provider/acp/DevinElicitationSupport.ts`.
- Add `apps/server/src/provider/acp/DevinElicitationSupport.test.ts`.
- Use the sanitized elicitation fixtures from Task 2.

**Interfaces:**

Expose pure request-normalization and response-encoding functions in `DevinElicitationSupport.ts`. Derive the request and result parameter types from the public ACP dependency and the `AcpSessionRuntime.handleElicitation` signature rather than inventing a second wire schema. The normalizer returns a discriminated union with `kind: "mcp-approval"`, `kind: "user-input"`, or `kind: "unsupported"`; the first two variants carry the ACP request ID and the mapped existing T3 fields. The encoder accepts the selected discriminant plus the existing `ProviderUserInputAnswers` or approval decision and returns the exact ACP response type. `UserInputQuestion` and `ProviderUserInputAnswers` remain the existing contract types.

**Steps:**

- [ ] Add fixture tests for the observed MCP approval form, structured question form, accept/decline/cancel results, optional question descriptions/options, malformed input, and unknown form values.
- [ ] Run `vp test run apps/server/src/provider/acp/DevinElicitationSupport.test.ts` and confirm the new tests fail before implementation.
- [ ] Implement request normalization without logging the request body, prompt text, secret values, or credentials.
- [ ] Map approval-like MCP elicitation to the existing `mcp-elicitation` request kind and map general structured questions to the existing `user-input` request path.
- [ ] Preserve question IDs, labels, descriptions, options, multi-select, and custom-answer capability using the existing `UserInputQuestion` shape; reject a question only when its required identifier or text is invalid.
- [ ] Encode the existing approval/user-input response into the exact observed ACP response shape and return a typed error for cancellation or malformed answers.
- [ ] Run `vp test run apps/server/src/provider/acp/DevinElicitationSupport.test.ts` and `git diff --check`.
- [ ] Commit as `feat(devin): normalize ACP elicitation requests`.

**Acceptance:** Real observed Devin elicitation forms have deterministic mappings to existing T3 request contracts, and invalid optional requests are rejected without corrupting the session.

### Task 7: Wire Devin elicitation into pending request lifecycle

**Files:**

- Modify `apps/server/src/provider/Layers/DevinAdapter.ts`.
- Modify `apps/server/src/provider/Layers/DevinAdapter.test.ts`.
- Modify `apps/server/src/provider/acp/AcpCoreRuntimeEvents.ts` only if an existing request/user-input event constructor cannot express the mapped event.

**Interfaces:**

- Register the existing `acp.handleElicitation` handler when creating the Devin ACP runtime.
- Reuse `pendingApprovals`, `pendingUserInputs`, `respondToRequest`, `respondToUserInput`, and existing stop/restart/interrupt cleanup.
- Emit `request.opened`/`request.resolved` for approval-like MCP elicitation and `user-input.requested`/`user-input.resolved` for structured questions.

**Steps:**

- [ ] Add a deterministic adapter test that sends a captured approval-like elicitation request through the mock ACP runtime and waits for the canonical request-opened receipt.
- [ ] Add a deterministic adapter test that sends a captured structured-question request and waits for the canonical `user-input.requested` receipt with the preserved question fields.
- [ ] Run `vp test run apps/server/src/provider/Layers/DevinAdapter.test.ts` to establish the failing integration assertions.
- [ ] Register `acp.handleElicitation` using the typed handler signature already exposed by `AcpSessionRuntime`; do not add an untyped JSON-RPC callback in `DevinAdapter`.
- [ ] Insert each pending request into the existing map before returning control to ACP so an immediate user response cannot race the registration.
- [ ] Route approval responses through `respondToRequest` and structured answers through `respondToUserInput`; translate each response with `encodeDevinElicitationResponse`.
- [ ] Add tests for accept, decline, cancel, stop, interrupt, model-change restart, ACP disconnect, duplicate response, and stale response. Assert no pending map entry remains after each terminal path.
- [ ] Ensure a malformed/unsupported elicitation request returns a protocol error or safe cancellation and does not block the next ordinary turn.
- [ ] Run `vp test run apps/server/src/provider/Layers/DevinAdapter.test.ts apps/server/src/provider/acp/DevinElicitationSupport.test.ts`.
- [ ] Commit as `feat(devin): wire ACP elicitation into pending requests`.

**Acceptance:** Devin elicitation requests appear in the existing T3 pending-request model, user responses reach the ACP peer in its native response shape, and all session termination paths settle pending work without hanging.

### Task 8: Verify elicitation through ingestion and existing web/mobile UI

**Files:**

- Modify `apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.test.ts` and/or `.approval.test.ts`.
- Modify `packages/client-runtime/src/pendingRequests.test.ts`.
- Modify `apps/web/src/components/chat/ComposerPendingApprovalPanel.test.tsx`.
- Modify `apps/web/src/session-logic.test.ts` if user-input activity needs coverage.
- Modify `apps/mobile/src/lib/threadActivity.test.ts` if the mobile projection needs coverage.
- Modify production contracts only if a test proves the current optional event payload cannot represent the observed form.

**Interfaces:**

- Existing `requestKindFromCanonicalRequestType("mcp_elicitation_approval")` behavior.
- Existing stale reply failure behavior in `derivePendingRequests`.
- Existing web `ComposerPendingApprovalPanel` MCP-elicitation branch.
- Existing mobile pending/activity mapping.

**Steps:**

- [ ] Add an ingestion test using the Devin-generated canonical events and assert persisted request/activity state matches a Codex/other-provider event with the same request type.
- [ ] Add a client-runtime test for pending approval and structured user-input folding, including resolution and stale reply handling.
- [ ] Add web and mobile regression tests that render the existing approval/user-input state without a Devin-specific conditional.
- [ ] Run `vp test run apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.test.ts apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.approval.test.ts packages/client-runtime/src/pendingRequests.test.ts apps/web/src/components/chat/ComposerPendingApprovalPanel.test.tsx apps/web/src/session-logic.test.ts apps/mobile/src/lib/threadActivity.test.ts` with only existing files that were touched.
- [ ] Run `vp run --filter t3 typecheck`, `vp run --filter @t3tools/web typecheck`, and `vp run --filter @t3tools/mobile typecheck` sequentially.
- [ ] Confirm the desktop wrapper requires no separate implementation because it consumes the web runtime and typed server events.
- [ ] Commit as `test(devin): verify elicitation across clients`.

**Acceptance:** Elicitation behaves identically to the existing provider-neutral approval/user-input flow on server persistence, web, desktop, mobile, remote, and tunnel connections.

---

## Phase 4: Subagent Parity

### Task 9: Capture and classify Devin child-agent events

**Files:**

- Extend test-local capture in `apps/server/src/provider/acp/DevinAcpCliProbe.test.ts` only if the live CLI can emit child-agent updates.
- Add `apps/server/src/provider/acp/DevinSubagentSupport.test.ts` for sanitized observed fixtures and unsupported behavior.

**Interfaces:**

- ACP `session/update` notification stream.
- Existing `task.started`, `task.progress`, `task.updated`, and `task.completed` payloads.
- `RuntimeTaskId` and `taskAgentLinkageFields` in `packages/contracts/src/providerRuntime.ts`.

**Steps:**

- [ ] Run the real Devin smoke harness with a prompt that asks for a child-agent/delegation operation only if the installed CLI exposes a documented, non-destructive way to do so; keep the normal smoke prompt unchanged.
- [ ] Capture only method names, stable IDs, parent IDs, lifecycle status, bounded summaries, and provider-neutral linkage fields.
- [ ] Classify the result as a stable child-agent stream, an event stream without stable identity, or no child-agent event support.
- [ ] Add deterministic fixture tests for the observed stable lifecycle, duplicate event, out-of-order event, missing parent, malformed event, and unsupported/no-stream result.
- [ ] Run `vp test run apps/server/src/provider/acp/DevinSubagentSupport.test.ts`.
- [ ] Commit the evidence tests as `test(devin): classify ACP subagent events`.

**Acceptance:** The repository contains evidence for either a safe stable child-agent mapping or an explicit unsupported result. Ordinary Devin tool calls are not treated as synthetic subagents.

### Task 10: Map stable child-agent events into the existing task runtime

**Files:**

- Add `apps/server/src/provider/acp/DevinSubagentSupport.ts` only when Task 9 produced stable event evidence.
- Modify `apps/server/src/provider/Layers/DevinAdapter.ts` only when Task 9 produced stable event evidence.
- Modify `apps/server/src/provider/acp/AcpCoreRuntimeEvents.ts` only if shared task-event constructors are missing.
- Modify `apps/server/src/provider/Layers/DevinAdapter.test.ts` and `apps/server/src/provider/acp/AcpRuntimeModel.test.ts` for the server boundary.

**Interfaces:**

- Stable Devin child-agent ID becomes `RuntimeTaskId`.
- Stable parent ID becomes existing task-agent linkage/parent linkage.
- Lifecycle maps to `task.started`, `task.progress`, `task.updated`, and `task.completed`.
- Duplicate notifications are idempotent; unknown child IDs produce bounded diagnostics rather than fabricated task starts.

**Steps:**

- [ ] Write failing mapper tests for start, progress, completion, failure, stop, duplicate delivery, parent linkage, missing optional fields, and an event with no stable identity.
- [ ] Run `vp test run apps/server/src/provider/acp/DevinSubagentSupport.test.ts` to establish the failing assertions.
- [ ] Implement a pure bounded mapper that returns no task event for ordinary tool updates or events without stable identity.
- [ ] Integrate the mapper into the Devin ACP notification fiber without changing the generic handling of `ToolCallUpdated`.
- [ ] Add an adapter integration test that observes canonical task events from the captured child-agent fixture and verifies event ordering by receipt rather than sleep.
- [ ] Run `vp test run apps/server/src/provider/Layers/DevinAdapter.test.ts apps/server/src/provider/acp/AcpRuntimeModel.test.ts apps/server/src/provider/acp/DevinSubagentSupport.test.ts`.
- [ ] If Task 9 found no stable event stream, do not add a production mapper; instead add a test that ordinary tool updates emit no `task.*` events and update the provider capability documentation in Task 12.
- [ ] Commit an implementation as `feat(devin): map ACP subagent lifecycle`, or commit only the unsupported regression test as `test(devin): keep unsupported subagents explicit`.

**Acceptance:** Stable Devin child agents appear through the same task/subagent runtime as other providers, with idempotent lifecycle handling and no synthetic agents. Unsupported transport behavior remains explicit.

### Task 11: Verify task/subagent activity on all clients

**Files:**

- Modify `apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.test.ts` if task persistence needs a regression.
- Modify `packages/client-runtime/src/state/subagentRuntime.test.ts`.
- Modify `apps/web/src/` Agents/task activity tests at their existing locations.
- Modify `apps/mobile/src/lib/threadActivity.test.ts` if mobile task activity has a separate projection.

**Interfaces:**

- Existing `subagentRuntime` fold and Agents panel model.
- Existing web and mobile task/activity projections.
- Existing persisted task events over local, remote, and tunnel transports.

**Steps:**

- [ ] Add a canonical Devin task-event fixture and assert the client-runtime fold creates one stable child-agent entry.
- [ ] Assert duplicate start/progress/completion events do not duplicate the child-agent entry or regress its terminal state.
- [ ] Assert unknown/incomplete task events render as existing diagnostic/unknown activity and do not create a fake agent.
- [ ] Run the focused server ingestion, client-runtime, web, and mobile tests touched by the fixtures.
- [ ] Run `vp run --filter @t3tools/web typecheck` and `vp run --filter @t3tools/mobile typecheck` sequentially.
- [ ] Commit as `test(devin): verify subagent activity across clients`.

**Acceptance:** Web, desktop, mobile, remote, and tunnel clients consume the same provider-neutral task events and preserve identity/lifecycle semantics.

---

## Final Documentation and Verification

### Task 12: Update Devin capability documentation

**Files:**

- Modify `docs/internals/providers.md`.
- Modify `docs/user/providers-devin.md`.

**Steps:**

- [ ] Update the maintainer provider matrix to list only capabilities proven by focused fixtures or the opt-in live CLI probe: MCP baseline, resources, elicitation, and/or child-agent events.
- [ ] Keep the explicit limitation that standard ACP does not guarantee a child-agent event stream when the installed Devin CLI does not provide stable events.
- [ ] Update user-facing Devin guidance only for behavior users can actually invoke; do not document capture flags, fixture internals, or test-only environment variables.
- [ ] Verify all command names and settings paths against the current code before editing the docs.
- [ ] Run `git diff --check` and the Markdown conflict-marker scan.
- [ ] Commit as `docs(devin): document ACP capability parity`.

**Acceptance:** Documentation accurately distinguishes verified support from transport limitations and does not promise a capability that the installed Devin CLI cannot provide.

### Task 13: Run the final focused verification gate

**Files:**

- No production file changes are expected in this task.

**Steps:**

- [ ] Run focused server tests for `DevinAdapter`, `DevinResourceSupport`, `DevinElicitationSupport`, `DevinSubagentSupport`, `AcpRuntimeModel`, `AcpCoreRuntimeEvents`, provider ingestion, provider registry, and existing Devin ACP support tests.
- [ ] Run focused contract/client-runtime tests for `providerRuntime`, `orchestration`, `pendingRequests`, work-log/activity folds, and `subagentRuntime` using explicit file paths.
- [ ] Run focused web and mobile tests for the touched session, approval, activity, and task projections.
- [ ] Run `vp run --filter t3 typecheck`, `vp run --filter @t3tools/web typecheck`, and `vp run --filter @t3tools/mobile typecheck` sequentially.
- [ ] Run `vp run test:devin-smoke` when a real Devin CLI and credentials are available; otherwise report the live acceptance gate as skipped with the reason and retain all deterministic evidence.
- [ ] Run `git diff --check`.
- [ ] Run `git grep -n -E '^(<<<<<<<|=======|>>>>>>>)' -- ':!devin-upstream-port-conversation.md'` and confirm no conflict markers exist in source.
- [ ] Run `git diff --name-only upstream/main...HEAD` and confirm changes are limited to Devin, shared provider-neutral runtime/client paths, tests, and the two relevant docs.
- [ ] Confirm `git status --short` still shows existing user files untouched and no generated credentials or live capture dumps.
- [ ] Summarize passed tests, skipped live tests, unsupported capabilities, and the commit list before any push or merge decision.

**Acceptance:** The implementation has a focused, reproducible verification report. No claim of completion relies on an unrun browser flow, an unavailable Devin binary, a sleep-based test, or a repo-wide check that was not requested.

## Handoff Checklist

- [ ] Each phase has one reviewable commit or an explicit no-source-change/unsupported result.
- [ ] No new Devin-specific UI was added when existing web/mobile components support the canonical event.
- [ ] No required WebSocket contract field was added without a failing compatibility test demonstrating the need.
- [ ] MCP credentials are provider-scoped, bounded, revoked during cleanup, and absent from logs/fixtures.
- [ ] Existing upstream behavior and unrelated providers remain unchanged.
- [ ] The live Devin MCP smoke command and its prerequisite environment are documented for the next machine.
- [ ] The implementation report is ready before pushing or merging into the fork's main branch.
