# Handoff — Devin Fusion model controls feature

**Date:** 2026-09-12 · **Status:** in progress (Tasks 1–3 committed, Task 3 under review)

## Where the work lives

- **Worktree:** `D:\Dev\t3code\.worktrees\devin-fusion` (branch `feat/devin-fusion-controls`)
- **Plan:** `D:\Dev\t3code\docs\superpowers\plans\2026-09-12-devin-fusion.md` (untracked, in MAIN checkout — not in the worktree)
- **Spec:** `docs/superpowers/specs/2026-09-12-devin-fusion-design.md` (committed)
- **SDD workspace + ledger:** `<worktree>\.superpowers\sdd\2026-09-12-devin-fusion\` — `progress.md` is the source of truth for task state; task briefs, reports, review diffs live alongside it.
- **Process:** subagent-driven development — one implementer subagent per task (TDD), then a reviewer subagent, fix loop on Important+ findings. Do NOT commit this file or anything under `.superpowers/`.

## Environment notes

- Windows + Git Bash. Node 24 and `vp` (Vite+) on PATH. Deps already installed in the worktree.
- Test cmd: `vp test run <file>` from worktree root. Web unit tests need `--project unit`.
- **`vp run --filter t3 typecheck` OOMs on this machine** (tsgo exhausts Windows commit limit). Implementer used a scoped tsconfig typecheck instead; full server typecheck was retried in background (shell 103bcf) — check its output, or run on a less-loaded machine.
- Stray `nul` file was deleted earlier; avoid `2>nul` redirects in Git Bash (creates a literal `nul` file).

## Done

| Task                                                                                                                   | Commit(s)                     | State                                                                                                                                                                   |
| ---------------------------------------------------------------------------------------------------------------------- | ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. Contracts `optionVariants`                                                                                          | `65bed1173`                   | Review clean. 2 parked minors (unused `describe` import; unasserted descriptor round-trip — both in `packages/contracts/src/model.test.ts`, which Task 7 touches again) |
| 2. Shared resolver (`__providerVariant`, `normalizeProviderOptionSelections`, `buildProviderOptionSelectionsForModel`) | `892c3d745` + fix `f59f12e4d` | Fix round 1 verified clean. 4 parked minors (see ledger)                                                                                                                |
| 3. Devin Fusion catalog parser (`parseDevinFusionModelUid`, one `fusion` row, catalog v4)                              | `035bf29e2`                   | DONE_WITH_CONCERNS — implementer says code pre-existed uncommitted from an interrupted prior run; reviewer dispatched, awaiting verdict                                 |

## Remaining

- Task 4: ACP routing — `apps/server/src/provider/acp/DevinAcpSupport.ts` + `Layers/DevinAdapter.ts` (+ tests). `resolveDevinModelUid` prefers valid `__providerVariant`, then concrete `fusion-*` model, then active-UID fallback; `resolveDevinAcpBaseModelId` maps `fusion`/`fusion-*` → `fusion`; same-family = `setModel` no restart; fusion↔standalone keeps restart; rejected change → typed ACP adapter error.
- Task 5: Web — `TraitsPicker.tsx`, `composerProviderState.tsx`, `modelFamilyGrouping.ts` (+ tests, `composerDraftStore.test.ts`). `fusionEffort` is the reasoning descriptor; all 4 controls render via generic descriptor loops.
- Task 6: Mobile — `providerOptions.ts`, `modelOptions.ts`, `ThreadSettingsSheet.tsx`, `ThreadComposer.tsx` (+ tests). Pass `ModelCapabilities` through; shared resolver for option updates.
- Task 7: `docs/user/providers-devin.md` Fusion section (no internal IDs/UID syntax) + `ServerProviderModel` remote-decode assertion in `packages/contracts/src/model.test.ts` (also fix Task-1 parked minors there).
- Then: final whole-branch review → push `git push -u origin feat/devin-fusion-controls` → `gh pr create` against **`mzakyali/t3code` main (the fork — never upstream `pingdotgg/t3code`)** → `gh pr checks --watch` → `gh pr merge` (no bypass flags).

## Key invariants (do not regress)

- Exact concrete `fusion-*` UID preserved via internal selection `__providerVariant` (constant name `PROVIDER_OPTION_VARIANT_SELECTION_ID`).
- Descriptor IDs exactly: `fusionLead`, `fusionEffort`, `fusionSidekick`, `fastMode`.
- Catalog is source of truth — no hardcoded Fusion lists/counts; catalog order + declared defaults preserved; malformed records skipped.
- `optionVariants` optional; no-variant providers byte-identical behavior.
- Clients never parse Devin UIDs; unknown non-variant options preserved.
- Focused tests only — never `vp check`, `vp run -r test`, `vp run -r typecheck`.
- Untracked files to leave alone: `devin-fork-handoff.md`, `devin-upstream-port-conversation.md`, other `docs/superpowers/` files, this handoff.
