# Development

This page is for contributors. Read [`AGENTS.md`](../AGENTS.md) for repository rules and [`RELEASING.md`](../RELEASING.md) for the release procedure.

## Code map

The maestro seams remain inside one npm package with the same Pi extension
entry point. Pi is the sole real harness and Herdr the sole real surface
provider; fakes are for conformance tests only.

- `pi-extension/subagents/index.ts` — Pi composition root: tools/commands,
  role-pack event bridge, host policy, widgets, and parent delivery.
- `pi-extension/subagents/model-registry.ts`, `config-path.ts` — permanent
  host-local SDK capability glue and configuration-path conventions.
- `maestro/core/` — seam interfaces/types, activity and lifecycle projection,
  status, routing, wake-ups, and supervision.
- `maestro/core/roles/discovery.ts`, `maestro/core/config/` — role discovery,
  and config loaders with injected directories.
- `maestro/core/worktree.ts`, `maestro/core/worktree-cleanup.ts` — manifest
  schema/state, handoff types, and cleanup eligibility/formatting.
- `maestro/adapters/pi/` — Pi launch, completion, session I/O, activity files,
  model SDK glue, and registry projection behind `PiHarnessAdapter`;
  `child/subagent-done.ts` implements the child protocol.
- `maestro/surfaces/herdr/` — `HerdrSurfaceProvider`, Herdr CLI driver,
  terminal scripts, and `herdr-socket.ts`, the bounded socket client for pane
  metadata. `placement.ts` is the sole family-aware surface allocator for the
  `agents` and `shells` tab families: it resolves the workspace, adopts family
  tabs statelessly from `tab list`/`pane list`, and applies `panes.maxPerTab`
  and `panes.direction`.
- `maestro/core/shell-jobs/` — shell job domain types and seams, the on-disk
  state store (records, logs, atomic result markers, 14-day pruning), and the
  `runner.sh` wrapper.
- `maestro/runtime/shell-jobs.ts`, `herdr-shell-surface.ts` — shell job
  supervision, wake/sweep, reconciliation, owner-only delivery, and the Herdr
  surface behind it.
- `maestro/runtime/` — run ownership, controls/retries, observation,
  delivery-gated cleanup, Pi composition, worktree operations/handoff, and
  sidebar markers (`delegated-marker.ts`).
- `pi-extension/subagents/widgets.ts`, `shell-jobs.ts` — the single status
  widget coordinator (shells above subagents) and the shell-job completion
  notice renderer and delivery.
- `plugins/sidebar/` — the optional Herdr plugin. Its `sidebar.mjs` uses Node
  built-ins only and imports nothing from the extension, so Herdr can install
  the directory by itself.
- `maestro/adapters/fake/`, `maestro/surfaces/fake/`, `test/maestro/` —
  conformance fakes, seam tests, and the import dependency-rule test.

See [ADR-0012](adr/0012-adopt-maestro-seams-in-repo.md), the
[glossary](../CONTEXT.md), and the [documentation map](README.md).

The **CI** workflow runs formatting, lint, unit tests, and the package preview
on pushes and pull requests to `main`, or manually from GitHub Actions. It has
read-only repository permissions and never publishes. Herdr integration tests
remain a local gate; the separate **Release** workflow still validates each
release before publishing.

Run local checks:

```bash
npm ci
npm run format:check
npm test
npm run lint
npm pack --dry-run
```

`npm run lint` needs Node.js 22.18+ (or 22.6–22.17 with `NODE_OPTIONS=--experimental-strip-types`) because oxlint imports TypeScript directly: its configuration, `oxlint.config.ts`, and the JavaScript plugin it loads, `tools/oxlint/anti-slop/index.ts`. Without type stripping, oxlint fails before linting with `Unknown file extension ".ts"`. This is a contributor tooling requirement, not a runtime requirement for package users.

Run the required end-to-end suite from inside Herdr:

```bash
npm run test:integration
```

Start the Herdr server with Node.js 22.19+ on its `PATH`, because test panes inherit the server's environment, not the test runner's: Pi 1.0.0 needs Node.js 22.19+ and crashes at startup on versions older than 22.15.

The deterministic suite launches real Pi sessions, Herdr panes, and worktrees without provider credentials. The optional live-provider smoke test is not a merge gate:

```bash
PI_TEST_MODEL="openai-codex/gpt-5.6-luna" PI_TEST_TIMEOUT=180000 \
  npm run test:integration:live
```

## Focused tests inside a worktree

A Herdr-managed worktree is a fresh checkout with no `node_modules`, and ESM
resolves bare specifiers from the importing file, so a focused test file fails
before any test runs. Register the resolver hook instead of linking
`node_modules` into the checkout:

```bash
NODE_OPTIONS="--import=$(git rev-parse --show-toplevel)/tools/worktree-resolve.mjs" \
  node --experimental-strip-types --test test/maestro/example.test.ts
```

The hook retries a bare specifier from the main checkout, located through the
shared Git common directory. Pass it through `NODE_OPTIONS` rather than
`--import`: `node --test` runs each file in a child process, and only
`NODE_OPTIONS` reaches those children. It writes nothing into the worktree, so the tree
stays clean for review. Worktrees still never run the full suite; the parent
runs the gate in the main checkout.

See [RELEASING.md](../RELEASING.md) for versioning, trusted publication, and release verification.
