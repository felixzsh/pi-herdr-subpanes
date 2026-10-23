# ADR-0016: Bounded persistent stop with kill escalation

- **Status:** Accepted
- **Date:** 2026-10-23
- **Scope:** `subagent_stop` for persistent specialists
- **Supersedes:** §8 of [ADR-0014](0014-operator-cancel-terminal-intent.md)
  (persistent specialists never killed; graceful-only stop)

## Context

ADR-0014 §8 rejects persistent runs from every kill path and keeps
`subagent_stop` graceful-only: with an active task the stop stays
`stop-pending` until the task settles, and only then does a bounded wait
check for process exit. Field evidence broke that contract's liveness:
a persistent child that never consumes its stop directive (observed after a
manual `/compact` inside the child pane retired its inbox poller while a
just-dispatched task was still unsettled) leaves the stop `pending`
forever. No timeout is armed for `pending`, every retry answers `Stop is
already requested`, and the operator has no recourse short of killing the
process by hand outside the extension. "Graceful" became "never".

The owner requires `subagent_stop` to mean definitive termination: bounded
wait, then owned termination, with an explicit `force` flag to skip the
wait.

## Decision

`subagent_stop` keeps graceful-first semantics and gains a bound:

1. **Graceful first, unchanged.** The stop directive is still written to the
   child's inbox and an active task still gets a bounded wait
   (`stopTimeoutMs`, 15 s default) to settle and the child to exit on its
   own.
2. **Escalation on expiry.** When the bound elapses with the specialist
   still alive — task settled or not — the extension terminates it through
   the same owned-termination primitive ADR-0014 defines (adapter `kill`:
   pane close plus absence confirmation, or SIGTERM to the verified process
   identity for retained panes). The existing terminal handoff confirms
   `stopped`; only a genuinely unconfirmed kill reports `failed`, as
   before.
3. **Explicit force.** `subagent_stop({ ..., force: true })` skips the wait
   and terminates promptly. It works from `requested`, `pending`, and
   `failed` states.
4. **What does not change.** `subagent_cancel` still rejects persistent
   runs. There is still no SIGKILL: escalation reuses ADR-0014 §7 signal
   rules verbatim (SIGTERM only, verified identity, fail-closed
   confirmation). Terminal intent, one result, and evidence retention are
   untouched.

## Consequences

- Every stop request now ends in `stopped` (process gone, confirmed) or
  `failed` (kill genuinely unconfirmed, still fail-closed). No stop can
  strand `pending` forever; deaf or compact-stranded children self-heal at
  the bound.
- A healthy task slower than the bound is terminated instead of being
  awaited. That is the documented contract change: stop bounds the wait.
  The child's session, ledger, and sidecars are retained as evidence, and a
  replacement specialist can resume the work.
- ADR-0014 stays in force for everything else, including ordinary cancel.
