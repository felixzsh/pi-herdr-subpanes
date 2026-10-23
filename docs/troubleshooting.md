# Troubleshooting

This page collects the checks for common problems. Each section links to the full reference.

## Troubleshooting completion delivery

If a child finishes but the parent returns an empty or unrelated response, first verify that the result reached the parent session:

```bash
jq -c 'select(.type == "custom_message" and .customType == "subagent_result")' "$PI_SESSION_FILE" | tail -1
```

If the entry exists, spawning and result extraction worked; investigate parent wake-up and model-facing delivery rather than the child process. Completion wake-ups must contain the bounded result directly—do not send a separate message that merely tells the parent to look at an adjacent custom message.

Git package refs are pinned. To move an installed development copy back to the current `main`, install that ref explicitly and reload the active Pi session:

```bash
pi install git:github.com/felixzsh/pi-herdr-bg@main
# Then run /reload inside Pi.
```

Smoke-test delivery with an autonomous subagent instructed to return one exact marker. Success means the marker itself—not only a generic wake-up notice—automatically appears in the parent turn.

Subagent tabs, panes, and worktree workspaces are created without stealing keyboard focus. Launch commands target child panes by explicit ID, so focus and command delivery are independent. If a fresh or resumed launch fails, the extension closes the ordinary pane that it created and preserves the original launch error. It does not close a caller-supplied surface, and managed worktree workspaces remain retained on failure. Note: the `interactive` option controls parent status notifications, not terminal focus.

## A child is stalled or makes no progress

The widget shows `stalled` when pane inspection fails or the pane disappears without a completion record. Time alone never makes a run stalled. A no-progress advisory warns once per episode and never interrupts, kills, retries, or restarts a child. Interrupt the child with `subagent_interrupt`, end an ordinary run with `subagent_cancel`, or stop a persistent specialist with `subagent_stop`. See [In-progress status updates](tools.md#in-progress-status-updates) and [Supervision transport](configuration.md#supervision-transport).

A child that keeps its session open after a turn (`auto-exit: false`) reports
its result when the turn ends, so it does not need `subagent_done`. If it stays
running with no result at all, check whether the last message ended mid-tool-use
or whether the child is `interactive` or persistent: those cases deliberately
wait instead of settling.

If a child sits on a `Trust project folder?` prompt, the pane is waiting for an answer nobody can give. A child inherits the parent session's project-trust decision for its own run, so this only happens when the parent itself is untrusted: trust the source repository in the parent, or launch the child with `cwd` inside a trusted path. A managed worktree needs no separate trust entry.

## A shell job stays `running`

A shell job is announced only by the session that owns it; a parent adopts a
child's job only after observing that child finish. If the owning session died
without an observed completion, nothing settles the job and it stays `running`
on purpose rather than let a foreign runtime steal a notice from a possibly live
owner. Close it explicitly:

```text
bg_shell_status({ action: "cancel", job_id: "sh_..." })
```

`cancel` marks the job `cancelled`, persists it, and closes its pane. Use
`bg_shell_status({ action: "get", job_id })` to confirm the state, and
`action: "log"` with a bounded `mode`/`lines`/`grep` to inspect output. A shell
pane has no agent, so Herdr `agent_status` is always `unknown` there; prompt
detection uses the pane's foreground process. While the runner or a child holds
that foreground process the job is still live, and a prompt that returns without
a result marker settles the job as `unknown`, never as success.

Job state lives under `$PI_CODING_AGENT_DIR/shells/` by default
(`~/.pi/agent/shells/`) and finished jobs are pruned after 14 days. If state
looks stale or misplaced, check `PI_SHELLS_DIR` if it is set. See
[Background shell jobs](tools.md#background-shell-jobs).

## A model fails

A catalog-listed model and configured authentication do not prove that your provider account can use the model. The completion keeps each raw provider reason with its model. Check account access, launch a new subagent with a supported model, or configure a fallback. See [Model resolution and fallback](configuration.md#model-resolution-and-fallback).

## Worktree removal is refused

Removal reports each blocker, such as dirty files, a live process, or an unknown inspection. Commit the work or pass `--preserve`, stop any process in the checkout, and start the parent Pi session at the source repository or an ancestor of it. See [Explicit worktree cleanup](tools.md#explicit-worktree-cleanup) and [cleanup and recovery](worktree-subagents.md#cleanup).

## Sidebar Focus hides nothing

Check that `sidebar.enabled` is `true`, that you ran `/reload` in the parent, and that you launched the child after the reload. Run `herdr pane get <child-pane-id>`: the pane must report the child's session file as `agent_session`. If it reports none, install Herdr's Pi integration with `herdr integration install pi` in the agent directory children use, then launch new children. Read the plugin log with `herdr plugin log list --plugin pi-herdr-bg.sidebar`. See the plugin's [troubleshooting](../plugins/sidebar/README.md#troubleshooting).
