# Devbox release requirement matrix

This is the standalone Devbox release audit for requirements R-001–R-022. The
requirement names and owning plan tasks remain aligned with the Devbox source matrix;
evidence paths use this repository's extracted layout. Automated evidence must exist in
this repository before a release is promoted. Manual pilot evidence is additive and does
not turn a blocked external transport requirement into a local pass.

| Requirement | Owning plan tasks | Evidence state | Concrete release evidence |
|---|---|---|---|
| R-001 pairing | T-002, T-006, T-007, T-008, T-010 | Fixtures + manual pilot | `src/core/devbox-rsync-seed.test.ts`; pilot: dry-run, conflict review, interrupted resume, and sentinel hashes. |
| R-002 parity/drift | T-001, T-002 | Fixtures + manual pilot | `src/core/devbox-preflight.test.ts`; pilot: coverage report, unclassified candidates, macOS (darwin) hub preflight acceptance, and no-op second reconcile. |
| R-003 safe sync | T-003, T-009 | Blocked on external transport | `src/sync/mutagen-cli-output.test.ts`, `src/sync/mutagen-sync-backend.test.ts`, `src/sync/devbox-sync-supervisor.test.ts`, `src/cli/mutagen-sessions.test.ts`, `src/cli/sync-now.test.ts`; manual pilot: Mutagen v0.18.1, ProxyJump, daemon recovery, entry-cap failure truth, conflicts, lag, multi-hub (one local root, two hubs) topology, `db sync` across reachable/unreachable/stopped machines, and resource evidence. |
| R-004 authority/no loss | T-001, T-004, T-009 | Fixtures + manual pilot | `src/core/authority/devbox-authority-epoch.test.ts`; pilot: transition fault matrix and old/new epoch proofs. |
| R-005 Git fidelity | T-004, T-009, T-010 | Fixtures + manual pilot | `src/core/authority/devbox-git-reconciler.test.ts`; pilot: read-only ~/project inventory and handoff round trip. |
| R-006 Phi context | T-002, T-004, T-006, T-010 | Fixtures + manual pilot | `src/core/authority/devbox-session-policy.test.ts`; pilot: remote Phi, PTY reattach, and closed-history fork. |
| R-007 credentials | T-005, T-009, T-010 | Contract tests + canaries + manual pilot | `src/core/devbox-credential-broker.test.ts`, `src/cli/profile-credentials.test.ts`, `src/cli/profile-paste.test.ts`, `src/core/devbox-paste-sync.test.ts`; pilot: provider enrollment/probes, opt-in ~/.mcp-auth roaming, opt-in clipboard-paste mirroring, and diagnostics/support canary scan. |
| R-008 persistent execution | T-006, T-007, T-009 | Fixtures + manual pilot | `src/core/devbox-job-supervisor.test.ts`, `src/core/devbox-job-transport.test.ts`, `src/cli/shell.test.ts`, `src/cli/shell-terminal-marker.test.ts`, `src/cli/shell-command.test.ts`, `src/cli/shell-new-run.test.ts`; Ubuntu pilot: detached jobs plus multi-session tmux attach/detach, disconnect survival, id/name reattach, private profile sockets, 100000 history-limit/mouse/extended-keys ordering, terminal host marker framing, and cleanup; macOS hub pilot: `db shell` works, missing `tmux` installs via Homebrew, and `db run` fails fast with the systemd-hub-required error. |
| R-009 ports/OAuth | T-005, T-006, T-007, T-010 | Contract tests + manual pilot | `src/core/devbox-ports-adapter.test.ts`, `src/ssh/system-ssh-runner.ts`; pilot: loopback/wildcard, reuse, and OAuth after reconnect. |
| R-010 diagnostics/recovery | T-001–T-009 | Journal tests + manual pilot | `src/core/devbox-operation-journal.test.ts`; pilot: final fault matrix and redacted recovery/support evidence. |
| R-011 scale | T-003, T-006, T-009, T-010 | Manual pilot / load | `src/harness/scale/scale.test.ts` covers lifecycle; pilot measures 200 children, 24 workers, latency, and backpressure. |
| R-012 UX/accessibility | T-007, T-008, T-009 | Components + CI/manual | `src/cli/format.ts`, `src/cli/format.test.ts`, `src/cli/profile-resolution.test.ts`, `src/cli/shell.test.ts`, `src/cli/shell-terminal-marker.test.ts`, `src/cli/interop-contract.test.ts`; CI/pilot: stable human/JSON canonical session tables, private/default socket transition, truthful degraded status/error wording, built-in status bar, keyboard-oriented four-verb flows, terminal host marker opt-out and byte framing, and accessible unknown-target wording. |
| R-013 zero-environment compatibility | T-006, T-008, T-009 | Regression tests + manual pilot | `src/cli/index.test.ts`, `src/sync/mutagen-resolver.test.ts`; pilot: standalone install, clean-environment profile/status/run and bare `shell ls` smoke, and disable/downgrade with no workspace mutation. |
| R-014 shipment | T-010 | Manual pilot / release evidence | `docs/RELEASE.md`; pilot: merged SHA, candidate checksum, public release assets, installation evidence, and rollback tag for v0.2.17. |
| R-015 credential passthrough | T-011 | Fixtures + manual pilot | `src/core/devbox-credential-env.test.ts`, `src/core/devbox-job-transport.test.ts`, `src/cli/shell.test.ts`, `src/cli/format.test.ts`, `src/core/devbox-profile-store.test.ts`; pilot: fake-token `/tmp` shell/run flow on both Ubuntu and macOS hubs, mode-600/atomic-rename filesystem proof, argv/log redaction audit, and real phi env rotation proof. |
| R-016 roaming profile contract | T-012 | Fixtures + manual pilot | `src/core/devbox-profile-store.test.ts`, `src/cli/profile-create.test.ts`, `src/cli/profile-ignore.test.ts`, `src/cli/profile-preferences.test.ts`, `src/cli/profile-device.test.ts`, `src/cli/profile-resolution.test.ts`; pilot: `--git-roaming --dry-run --json`, plain and roaming schema-versioned ignore add/list/rm, profile entry-cap set/show, repeatable create `--ignore`, v1 migration, absolute roots, re-pair semantics, `--device` alias set/show/clear/collision and `--profile`/`--device` resolution, and secret/argv audit. |
| R-017 private Git metadata fencing | T-012, T-013 | Fixtures + manual pilot | `src/core/authority/devbox-git-roaming.test.ts`, `src/core/authority/devbox-git-roaming-inventory.ts`; pilot: `.git` remains private, passive raw Git fails, parked proxy reads succeed. |
| R-018 authority handoff epochs | T-013, T-014 | Fixtures + manual pilot | `src/core/authority/devbox-git-roaming.test.ts`, `src/core/authority/devbox-authority-epoch.test.ts`; pilot: flush→verify→pause→park/unpark→commit→resume barrier trace and round trip. |
| R-019 checksummed witness refresh | T-014 | Fixtures + manual pilot | `src/core/authority/devbox-git-roaming-remote.ts`; pilot: marker round trip, checksum tamper refusal, origin-less/fetch-failure pair warnings with repository and stderr, strict handoff refusal. |
| R-020 roaming preflight | T-012, T-015 | Fixtures + manual pilot | `src/core/devbox-git-roaming-preflight.ts`, `src/core/devbox-preflight-paths.ts`; pilot: pair-time dirty/unpublished/worktree findings are informational, hard path collisions block, ignored/out-of-root issues warn with JSON evidence. |
| R-021 crash recovery | T-014, T-016 | Fixtures + manual pilot | `src/core/authority/devbox-git-roaming.test.ts`, `docs/devbox-recovery.md`; pilot: SIGINT at pair-init and handoff park stages, candidate/committed replay with no deleted metadata. |
| R-022 release/live smoke | T-016 | Manual pilot / release evidence | `docs/RELEASE.md`; pilot: throwaway two-machine fixture, private tmux socket/status/mouse/clipboard evidence, OSC 9998 terminal host marker byte capture, degraded-status evidence, teardown, v0.2.17 assets and local reinstall verification. |
| R-023 in-place shell reconnect | T-017 | Fixtures + manual pilot | `src/cli/shell-reconnect.test.ts`, `src/cli/shell.test.ts`; pilot: ssh exit 255 reconnect prompt, Enter retry, q/Ctrl-C opt-out, marker re-emission, and `DEVBOX_SHELL_RECONNECT=0`. |
| R-024 shell resume history | T-017 | Fixtures + manual pilot | `src/cli/shell-attach-history.test.ts`, `src/cli/shell.test.ts`, `src/cli/shell-command.test.ts`; pilot: terminal → profile → most-recent precedence, stale record skipping, and local `shell-attach-history.json` persistence. |
| R-025 reconnect-all Forca recovery | T-017 | Fixtures + manual pilot | `src/cli/shell-reconnect-all.test.ts`, `src/cli/forca-terminals.test.ts`, `src/cli/format.test.ts`, `src/cli/handlers.test.ts`; pilot: dry-run plan, sequential titled Forca launch by tmux session name, every-device coverage with unreachable-device reporting, failed-row reporting, unavailable-Forca manual fallback, and here-session attach. |

## Release interpretation

No row is complete from this table alone: cited automated evidence must pass and every
stated pilot step must have a durable report. R-003 remains blocked on external
Mutagen/OpenSSH transport evidence and manual pilot results; local sync tests do not
replace that proof. R-005, R-006, R-007, R-008, R-009, R-011, R-012, R-013, R-014, and R-015
include real-host, CI, or operator evidence that cannot be honestly replaced by a local
unit test.
