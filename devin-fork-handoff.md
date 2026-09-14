# Devin Fork Handoff

## Objective

Continue developing the Devin provider integration for personal use in the fork `mzakyali/t3code`.
There is no intention to open or maintain a pull request against `pingdotgg/t3code`; the previously opened upstream PR was closed.

## Repository state at handoff

- Repository: `D:\Dev\t3code`
- Branch: `feat/devin-upstream-port`
- HEAD: `ed2ba85d599979cbb9ef010f4ce2317f5c3d003f`
- HEAD message: `merge(upstream): sync latest upstream main`
- `upstream/main`: `6c583620ff7ad3235b135af7107c0543467eecfa`
- Working tree: no tracked changes and no active merge
- Local feature branch: 102 commits ahead of `origin/feat/devin-upstream-port`
- Fork remote: `origin` → `https://github.com/mzakyali/t3code.git`
- Upstream remote: `upstream` → `https://github.com/pingdotgg/t3code.git`

Preserve these untracked user files:

- `devin-upstream-port-conversation.md`
- `docs/superpowers/plans/`
- `docs/superpowers/specs/2026-09-04-devin-skill-discovery-design.md`

## Completed implementation

The fork contains:

1. The Devin ACP provider port: contracts, driver, adapter, provider registration, usage/pricing, web/mobile UI, tests, docs, and smoke harness.
2. Devin skill discovery through `devin skills list --json`.
3. Skill snapshot exposure through `snapshotForCwd`.
4. Native prompt dispatch: known `$skill` mentions become `[skills:skill](skills:skill)` while unknown tokens, arguments, surrounding text, and `$HOME` remain unchanged.
5. Lazy per-session/workspace discovery caching with original-prompt fallback when discovery fails.
6. ACP lifecycle, approval, resource, subagent-event classification, usage, and mobile activity fixes made while syncing upstream.

Important implementation boundary: richer ACP behavior such as elicitation, resource mentions, and subagent events should only be expanded when the actual Devin protocol behavior is confirmed. Do not invent new MCP or WebSocket contracts just to make Devin resemble another provider.

## Verification already completed

- Devin skill/dispatch/driver/adapter focused tests: `56 passed, 3 skipped`.
- Devin provider/text-generation/ACP/registry tests: `91 passed`.
- Web and mobile typechecks: passed.
- Server typecheck: direct single-threaded `tsgo --noEmit` passed with suggestions only. The default parallel Windows run hit environmental `VirtualAlloc errno=1455` memory pressure.
- `git diff --check`: clean.
- No conflict markers or unmerged files.
- Devin CLI is available at `C:\Users\user\AppData\Local\devin\cli\bin\devin.exe`.
- `devin --version`: `devin 3000.10.21 (611c1cba)`.
- `devin auth status`: logged in to Devin Teams.

Not yet verified in the latest pass: live skill discovery through the real CLI, live ACP behavior, live MCP behavior, and integrated web/mobile manual testing.

## Recommended next sequence

### 1. Confirm state before mutation

Run:

```powershell
git status --short --branch
git log -1 --oneline --decorate
git branch -vv
```

Confirm the preserved untracked files remain untouched and there is no active merge.

### 2. Publish the feature branch to the fork

Only after confirming the state, push the local feature branch to the fork:

```powershell
git push origin feat/devin-upstream-port
```

Do not create or reopen an upstream PR.

### 3. Run live Devin checks

Use a normal terminal, not a nested interactive Devin session. Start with:

```powershell
devin --version
devin auth status
devin skills list --json
```

Then run the repository’s existing strict Devin smoke harness if available. Treat skipped CLI-probe tests as unverified, and keep MCP smoke assertions strict: a timeout or missing expected broker request is a failure, not a pass.

### 4. Test the clients

For web and mobile, verify the Devin provider in the same user-visible flows supported by the other providers: provider selection, new thread, sending a turn, streaming text, approvals, tool/resource activity, cancellation, restart/model change, usage display, and reconnect/remote mode where applicable.

Follow the repository’s `test-t3-app` and `test-t3-mobile` procedures when browser or simulator testing is explicitly requested. Use isolated worktree state; never point a test server at live `~/.t3/userdata`.

### 5. Merge into fork `main` when satisfied

Do this only after the live checks and client smoke pass:

```powershell
git fetch origin
git switch main
git pull --ff-only origin main
git merge --no-ff feat/devin-upstream-port
git push origin main
```

Keep `feat/devin-upstream-port` as a backup/reference branch. If fork `main` has advanced in a way that makes the merge non-fast-forward or conflicted, stop and inspect before resolving.

### 6. Future feature work

Start new work from the fork’s `main` after it contains the verified integration. Keep each feature isolated in a new branch. Prioritize protocol-backed parity gaps, then add focused server/client tests and targeted typechecks before merging.

## Guardrails

- Fork-only development; no upstream PR.
- Preserve the three untracked user files listed above.
- Do not use destructive reset/checkout commands.
- Do not kill processes by name or pattern.
- Do not run repo-wide checks; use focused tests and package typechecks.
- Do not claim live Devin/MCP support based only on mocked or skipped tests.
- Any frontend behavior change must account for web, desktop wrapper, and mobile, plus local and remote connection modes.

## Handoff completion criterion

The next session should first verify the repository state, then either publish the feature branch and run live checks, or report the exact blocker. It should not create an upstream PR.
