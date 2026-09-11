# Provider constraints

Orchestration records intent and state without knowing which provider runs a thread. Provider
protocols, account ownership, permissions, and capabilities belong at the
[adapter boundary](../../apps/server/src/provider/Services/ProviderAdapter.ts). Normalize there
instead of spreading provider checks through reactors and clients.

A driver kind identifies an integration; an instance identifies one configuration and account
lifecycle. Route work by instance, so two accounts using the same driver do not share mutable
session or catalog state.

## Process and account isolation

T3-managed OpenCode chat uses one server per thread. Its MCP registrations are directory-scoped, while
T3's MCP connection is thread-scoped. Sharing a chat server between threads in one directory would
let them replace each other's connection. Catalog and text-generation work can share the
[instance-owned helper](../../apps/server/src/provider/OpenCodeServerOwner.ts), which closes
after an idle period. External OpenCode servers remain externally owned and can require an
external restart to pick up configuration changes.

OpenCode also stores persistent approval grants per directory. Automatic full-access replies use
`once` so they cannot widen a supervised thread's permissions on a shared external server.
See the [adapter](../../apps/server/src/provider/Layers/OpenCodeAdapter.ts).

Antigravity separates account profiles per instance while sharing installed executables across the
environment. It forces file-based credential storage because the native macOS keychain entry would
otherwise be shared across instances. The launch environment removes ambient Google credentials,
so an instance cannot silently use another account or billing project. The agent also resolves
its user-global skill directories under that profile, so the profile links those two directories
back to the user's real `~/.gemini`; MCP servers, hooks, and rules there stay out of the profile.
See [profile isolation](../../apps/server/src/provider/antigravityAuthSupport.ts).

The [Antigravity installer](../../apps/server/src/provider/AntigravityInstallation.ts) outlives
client connections and provider-instance rebuilds. Releases are immutable, with an atomic pointer
selecting the version for new processes. Running processes hold leases on their version. Updates
and removal must respect those leases instead of replacing executables under a running agent.

## Setup must not happen as a health-check side effect

Opening a provider session can start MCP servers, run hooks, or launch a login browser.
[Grok probes](../../apps/server/src/provider/Layers/GrokProvider.ts) avoid authentication and
session creation for this reason. Antigravity likewise reserves authenticated catalog sessions for
explicit setup or model refresh; background checks use initialization only.

[Antigravity sign-in](../../apps/server/src/provider/AntigravityAuth.ts) belongs to the initiating
T3 auth session. The client carries the return URL back to the environment because the provider's
loopback listener may be on another machine. Forward only the callback for the owned pending flow;
a successful callback HTTP request is not proof that provider authentication finished. The native
process owns token exchange and storage.

Antigravity sign-out closes admission to new processes and stops existing processes before clearing account
metadata. Otherwise a helper or resumed session could retain the old account. Cached model lists
do not establish current access, and an authoritative empty catalog must clear the old list.

Antigravity text-generation helpers deny tool requests, but native hooks and MCP configuration can
run before the prompt. They reject profiles with such configuration before launch. Prompt
instructions and tool denial do not create a native sandbox.
See [helper constraints](../../apps/server/src/textGeneration/AntigravityTextGeneration.ts).

## Provider updates run only through the owning installer

A one-click update is offered only when the resolved executable's path proves which installer owns
it. Homebrew and npm are proven by the real path (symlinks followed): a versioned keg or cask under
`brew --prefix`, or `<prefix>/lib/node_modules/<pkg>/` (Windows: the shim beside `node_modules`).
Native installer layouts and the global bin directories of pnpm, Bun, and Vite+ may match on either
the resolved path or its real target, since those installers place real files or their own symlinks
there. Anything unproven stays manual-only but still reports the version gap. npm updates pin
`--prefix` because the `npm` on `PATH` can belong to a different Node than the one that owns the
provider. Homebrew
compares against `brew info` since casks trail npm by hours; native installs share npm's version
train, so the registry stays authoritative for them.
See the [resolver](../../apps/server/src/provider/providerMaintenance.ts).

Ownership is cached per instance and re-read immediately before an update runs. The
[runner](../../apps/server/src/provider/providerMaintenanceRunner.ts) refuses when the lock key
changed since the advisory, and reports success only when the refreshed provider is still installed
with a readable, current version.

## Protocol traps

Codex async questions arrive as notifications and are answered with a new user message. There is
no pending RPC response to send. Blocking questions still use the request/response path. The
[adapter](../../apps/server/src/provider/Layers/CodexAdapter.ts) distinguishes them; the
[decider](../../apps/server/src/orchestration/decider.ts) records an async answer and its user
message together.

An async question can outlive the turn or a server restart. The engine reads that request's
durable activity before resolving it because the in-memory command snapshot omits old activities.
Do not infer that a request has disappeared merely because it is outside the recent window.

Capabilities must describe what the provider can actually do. Antigravity can capture workspace
checkpoints but cannot roll back its conversation. The [checkpoint boundary](./overview.md#turn-completion-and-checkpoints)
therefore rejects revert before touching files. Native permission and question option IDs must
also survive normalization; a display label is not necessarily a valid reply.

## Devin ACP

Devin runs its CLI as an ACP subprocess (see
[DevinDriver](../../apps/server/src/provider/Drivers/DevinDriver.ts)). Model discovery follows the
same startup and settings-change refresh path as the other managed providers. Its CLI family
variants are normalized into parent model rows with reasoning, speed, and context-window option
descriptors before the snapshot is published. Devin snapshots carry a provider-owned model catalog
version; when that version changes, the registry replaces (rather than merges) the previous
snapshot and rewrites the per-instance status cache.

Devin ACP telemetry is normalized in `DevinAdapter` from both `usage_update` notifications (context
window and cumulative session cost) and prompt response usage (per-turn token deltas). The adapter
emits the shared `thread.token-usage.updated` event, which feeds the composer context meter and the
Usage service. Usage scans canonical `events.<thread>.log` files only; native ACP protocol lines
are retained for diagnostics but are not treated as billing records. When explicitly configured,
the Usage service also reads Devin's organization consumption endpoint with a server-only service
key and organization ID. That ACU result is an optional `UsageSummary.accountUsage` field and
remains separate from token/cost buckets.

The Devin capability boundary is:

| Capability         | Status                                                   | Boundary                                                                                                                                                                                                                                                                |
| ------------------ | -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| MCP baseline       | Local transport verified; live Devin handoff failing     | `DevinAdapter` sends the existing T3 MCP HTTP server declaration with provider-scoped bearer auth. Direct local MCP `initialize` and `tools/list` work. The opt-in real Devin turn is not passing: it makes zero T3 MCP broker requests and does not return the marker. |
| Resources          | Transport and projection ready; live emission unverified | A pure typed ACP normalizer, adapter-boundary sanitization, canonical event retention, and generic web/mobile projection coverage are present. The installed Devin CLI emitted no resource blocks, so live Devin resource emission and rendering are unverified.        |
| Elicitation        | Unsupported                                              | Public ACP form requests do not provide a per-elicitation correlation ID, and the installed Devin CLI emitted none; no handler is wired.                                                                                                                                |
| Child-agent events | Unsupported                                              | No documented or typed stable child-agent stream, identity, lifecycle, or parent linkage was observed. Ordinary tools remain generic. Standard ACP does not guarantee a child-agent event stream, so the Agents panel cannot promise Devin child-agent telemetry.       |

These capabilities reuse the provider-neutral web, desktop, mobile, and remote paths. No Devin-specific
UI or contract was added.

The focused Devin MCP probe is run with `vp run test:devin-smoke`. It is opt-in and skips during
normal tests. If `devin` is not on `PATH`, set `T3_DEVIN_BINARY_PATH` to the CLI binary.

## Attachments and stored history

Attachments live outside the project workspace. [ProviderService](../../apps/server/src/provider/Layers/ProviderService.ts)
puts their environment-local paths in turn input and lets adapters choose native input formats.
A path in the prompt does not grant filesystem access. Keep provider sandbox and approval rules
in force; copying uploads into the project to bypass them changes that boundary.

File attachments introduced a replay compatibility limit. Image-only clients cannot decode
file-bearing messages, and an image-only server can fail the entire environment's startup when
replaying one such event. Rollouts and downgrades must account for persisted history as well as
current client support.

Model classification has its own [manifest constraints](./model-manifest.md). Assistant-reference
handling is documented under [citations](./assistant-citations.md).
