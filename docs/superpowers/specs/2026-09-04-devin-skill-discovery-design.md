# Devin skill discovery and dispatch

**Status:** Approved design, awaiting written-spec review before implementation
**Date:** 2026-09-04

## Context

T3 Code already has a provider-neutral `ServerProviderSkill` contract, workspace
snapshots, and shared web/mobile composer behavior. The existing `$` picker can
therefore display skills supplied by a provider without a new UI or wire
contract. Claude and Grok already use provider-specific discovery and dispatch
logic as adapter-bound concerns.

Devin currently exposes no skills in its provider snapshot, so its skills do
not appear in the existing picker. Devin's native CLI provides the authoritative
inventory through `devin skills list --json`; its documented invocation form is
`@skills:skill-name` ([Devin skills documentation](https://docs.devin.ai/product-guides/skills)).
T3's composer emits a provider-neutral `$skill-name` token, which the Devin
adapter currently forwards unchanged.

## Goals

1. Discover Devin skills for the selected workspace, including the Devin
   installation's global and project skill locations.
2. Populate the existing provider skill snapshot so the current web and mobile
   `$` pickers can search and select Devin skills.
3. Translate a selected, known T3 skill token into Devin's native
   `@skills:<name>` syntax while preserving arguments and ordinary dollar text.
4. Keep discovery failures nonfatal: normal Devin sessions and turns must remain
   usable when the CLI is missing, times out, exits unsuccessfully, or returns
   malformed data.
5. Keep the implementation scoped to the Devin provider boundary and covered by
   focused parser, discovery, dispatch, and integration-level tests.

## Non-goals

- Implementing richer ACP features such as elicitation, resource mentions, or
  subagent events. Those are a later capability track.
- Fixing Devin's current ACP/MCP runtime behavior or making the T3-provided MCP
  server visible to Devin. Skill discovery is independent of that acceptance
  test.
- Adding a new UI component, skill-specific mobile flow, or WebSocket field.
- Replacing native Devin skill discovery with a filesystem scan.
- Defining multi-skill composition semantics. The supported composer interaction
  remains one selected skill per turn; Devin owns the behavior of its native
  syntax.
- Changing skill discovery or dispatch behavior for other providers.

## Chosen approach

Use Devin's native JSON discovery command and reuse T3's existing provider skill
model. The implementation has one pure parser and one effectful command runner
in `apps/server/src/provider/Drivers/DevinSkills.ts`.

The parser is responsible only for validating and normalizing CLI records. The
runner is responsible for resolving the Devin binary, supplying the selected
workspace as the child-process cwd, collecting bounded output, decoding JSON,
and converting process failures into a typed provider discovery error.

This keeps provider orchestration independent from Devin's output shape and
keeps all Devin-specific complexity at the adapter/driver boundary.

## Architecture and data flow

### Provider snapshot discovery

1. Add `snapshotForCwd` to the Devin `ProviderInstance`, following the existing
   Claude, Grok, Codex, and OpenCode patterns.
2. When the provider registry refreshes a workspace snapshot, call
   `devin skills list --json` with that workspace as cwd.
3. Parse the result into `ServerProviderSkill[]` and place it in the existing
   `workspaceSnapshots` entry alongside Devin's slash commands.
4. The existing `ServerProvider` and `packages/client-runtime` skill helpers
   deliver the snapshot to web and mobile. No new client contract or picker is
   required.

The command runner must use the provider instance's configured binary path and
environment. It must not use the live T3 home or read global T3 state. The
selected project cwd is the only workspace context passed to discovery.

### Skill record normalization

For each valid CLI record:

- Require a non-empty `name` and `base_dir`. Malformed records are skipped
  rather than making the entire snapshot unusable.
- Map `base_dir` to `path` as `base_dir/SKILL.md`, using the injected Path
  service so Windows and POSIX paths are handled consistently.
- Map `description` to `description` and `display_name` to `displayName`.
- Set `userInvocable` when `triggers` contains `user`.
- Set `userInvocationOnly` when `triggers` contains `user` but not `model`.
- Set `enabled` to false when the record has errors; warnings do not disable a
  skill.
- Derive a stable scope from `base_dir`: skills under the selected cwd are
  classified as project, known Devin user-global roots as personal, and other
  locations use `other` rather than being discarded. The existing client source
  display logic already derives its category from these `scope` and `path`
  fields.
- Decode the top-level JSON array emitted by the command; a non-array payload is
  a discovery failure.
- Deduplicate names case-insensitively and sort deterministically so picker
  ordering does not depend on CLI enumeration order.

An otherwise valid empty JSON array is an authoritative empty result. A failed,
timed-out, undecodable, or wholly unusable command result is a typed discovery
failure and must not replace a previously valid workspace snapshot with an
invalid empty one.

### Devin prompt dispatch

The Devin adapter will retain the discovered skill names for the active session
workspace. To avoid adding latency to ordinary turns, the adapter performs
lazy, session-scoped discovery when a prompt contains a candidate `$skill` token
and reuses the result for later turns in that session. The adapter can use its
existing captured settings/per-session settings resolver and process services;
it must not create a second source of truth for skill metadata.

Dispatch uses the same token boundary rules as T3's existing skill dispatch:

- A known `$name` becomes `@skills:name`.
- Prompt text after the token is preserved, so `$deploy staging` becomes
  `@skills:deploy staging`.
- Unknown dollar tokens remain unchanged, including shell variables such as
  `$HOME`.
- Text surrounding a known token is preserved.
- Discovery failure leaves the original prompt unchanged and is logged at the
  provider diagnostic level without exposing environment values or prompt
  contents.

The adapter will not infer a skill from an arbitrary filesystem path or rewrite
an unknown token merely because it resembles a skill name.

## Failure, performance, and security behavior

- Discovery has a bounded timeout consistent with the other provider skill
  probes (20 seconds is the initial target).
- Spawn, timeout, nonzero exit, output-limit, JSON decode, and invalid-record
  failures are represented as typed Devin discovery errors with a stage and
  safe diagnostic detail.
- A workspace snapshot refresh preserves the last known valid provider state
  when discovery fails, as required by the provider registry merge behavior.
- The adapter treats lazy-discovery failure as a best-effort miss; it never
  prevents a turn from being sent.
- A failed lazy probe is not cached as a permanent empty inventory. It may be
  retried on a later session or after the normal session lifecycle resets.
- Child processes inherit only the configured provider environment. Logs must
  not include secrets, full environment dumps, or complete user prompts.
- Discovery is session/workspace scoped and bounded; it must not run once per
  ordinary turn after a successful result.

## Surfaces and compatibility

- **Server:** new Devin discovery module, Devin driver workspace snapshot, and
  Devin adapter dispatch translation.
- **Web:** existing provider skill search and composer picker consume the
  snapshot automatically; no new UI code is planned.
- **Mobile:** existing shared skill helpers and composer popover consume the
  snapshot automatically; no new UI code is planned.
- **Desktop:** wraps the web client and server; no separate feature path is
  expected.
- **Remote/relay/tunnel:** the skill inventory crosses the existing typed
  provider snapshot stream, so remote clients receive the same data as local
  clients.
- **Other providers:** unchanged.

## Verification plan

Focused tests will cover:

1. Pure parsing of valid JSON records, descriptions, display names, paths,
   scopes, trigger combinations, disabled/error records, warnings, malformed
   records, deterministic sorting, and case-insensitive deduplication.
2. Command execution with the selected cwd, configured binary path, timeout,
   nonzero exit, invalid JSON, and an authoritative empty array.
3. Devin driver snapshot wiring and preservation of the normal provider status
   when skill discovery fails.
4. Prompt translation for known and unknown `$` tokens, `$HOME`, surrounding
   text, and trailing arguments.
5. An adapter-level send-turn test proving the translated prompt is what Devin
   receives while a discovery failure still sends the original prompt.

Verification is limited to the touched server/packages tests, focused lint or
typecheck commands, and the existing isolated Devin smoke command when the
local Devin runtime is available. The live ACP/MCP smoke test remains a
separate acceptance gate and is not required to implement or unit-test skill
discovery.

## Rollout and follow-on work

Land skill discovery and native dispatch as the next Devin capability slice.
After focused verification, rerun the isolated end-to-end Devin test later when
the local Devin runtime exposes the expected ACP/MCP behavior. Only after that
baseline is stable should richer ACP features—elicitation, resource mentions,
and subagent events—be designed as a separate capability with its own protocol,
contract, UI, and multi-surface decisions.

There are no unresolved product decisions for this slice. Implementation may
choose local helper names and exact error constructors as long as the behavior
and boundaries in this document remain unchanged.
