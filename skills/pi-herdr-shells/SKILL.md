---
name: pi-herdr-shells
description: Run and inspect background shell jobs in Herdr. Use when asked to run a long non-interactive command asynchronously with bg_shell; to list jobs, read bounded log fragments, or cancel jobs with bg_shell_status; when a job finished, stalled, or left a pane behind; or to configure the shells state directory, retention, and pane placement.
---

# pi-herdr-shells operating guide

## Authority and version caveat

Live tool descriptions and the installed package's documentation are
authoritative; this guide is a summary. Check the installed version and which
`bg_shell*` tools you have before relying on source from another branch or
release. Resolve this guide's relative links from its directory, not the
user's working directory.

## What shell jobs are

`bg_shell` runs one long, non-interactive shell command in a pane of the
workspace's extension-owned `shells` tab family and returns a job id at once.
The command must run inside Herdr (`HERDR_ENV=1`, i.e. Pi started from inside
Herdr). Use it instead of `bash` for full builds, entire test suites, long
migrations, or anything likely to take several minutes and safe to run
without interaction. Keep `bash` for quick, interactive, or ordering-critical
commands that must finish before the next step.

Subagent delegation lives in the sibling skill: load
`/skill:pi-herdr-subpanes` to launch, supervise, interrupt, cancel, or resume
Pi child agents, or to observe a child finish before adopting the job it
started.

## Results arrive automatically: never poll

Do not poll. Continue other work or stop; the completion notice arrives as a
steer message with the exit code and a bounded log tail. If a job is merely
slow, do nothing.

## Running: `bg_shell` parameters

`command` is required. Everything else is optional.

| Parameter | What it means |
| --- | --- |
| `command` | Shell command to run. It must be non-interactive. Keep it streaming (see below). |
| `cwd` | Working directory. Defaults to the current session cwd and must exist. |
| `label` | Short human-readable name for the job and its pane. |

## Inspecting: `bg_shell_status` parameters

`action` defaults to `list`. `job_id` is required for `get`, `log`, and
`cancel`.

| Parameter | What it means |
| --- | --- |
| `action` | `list` (default), `get`, `log`, or `cancel`. |
| `job_id` | Job id, required for `get`, `log`, and `cancel`. |
| `all` | Widen the list and job lookup to every Pi session, not only this one. |
| `mode` | For `log`: read from the `head` or `tail`. Default `tail`. |
| `lines` | For `log`: 1–400 lines, default 100. Out-of-range values are clamped. |
| `grep` | For `log`: keep only lines matching this regular expression. |

`list` shows running jobs and up to 10 recent finished ones, newest first. By
default it covers jobs started by this session and jobs its children started.
`get` returns the job's facts and a bounded tail preview. `log` returns the
requested head or tail fragment; the read window is capped at 512 KB and the
rendered output at 8 KB.

## Keep the command streaming

Never pipe a long-running command into `tail`, `head`, or `grep` inside the
command string: the pipeline buffers output, so the pane and log stay empty
until the end. Let output flow and read bounded fragments afterwards with
`bg_shell_status({ action: "log", job_id, mode: "tail", lines, grep })`.

## Job states

| State | Meaning |
| --- | --- |
| `running` | The command is still executing, or its result is not yet observable. |
| `succeeded` | The runner recorded exit code 0. |
| `failed` | The runner recorded a non-zero exit code. |
| `unknown` | The pane disappeared, the process died without a result marker, or the command never started. Never reported as success. |
| `cancelled` | An explicit `bg_shell_status cancel` settled the job. |
| `error` | The pane could not be created or the command could not be launched. |

State is settled by an atomic result marker written by the runner, an explicit
cancel, or a launch failure, never by parsing pane output. A shell pane has no
agent, so its Herdr `agent_status` is always `unknown`.

## Cancelling a job

`bg_shell_status({ action: "cancel", job_id })` marks a running job
`cancelled`, persists it, and closes its pane immediately. Do not close the
pane by hand, and do not expect a prompt from the process. A job left
`running` after its owning session died unobserved is closed the same way.

## Ownership and adoption

Only the owning session announces a job: the session that started it, or its
parent when the caller was a child. A parent may adopt a child's job only
after observing that child complete, fail, or be cancelled; adoption announces
the result once. A runtime never settles another session's job, not even
silently: if the owner dies without an observed completion, the job stays
`running` and is resolved explicitly with `bg_shell_status cancel`. To observe
the child itself finish, load `/skill:pi-herdr-subpanes`.

## State and retention

State lives under `$PI_CODING_AGENT_DIR/shells/` (default
`~/.pi/agent/shells/`); `PI_SHELLS_DIR` overrides the root. Finished jobs and
their files are pruned after 14 days; a `running` job is never pruned.
`panes.maxPerTab` and `panes.direction` govern `shells` panes exactly as they
govern `Agents` panes; see `models`, `panes`, and `supervision` in
[configuration](../../docs/configuration.md).

## Finding current help

Read live tool descriptions first, then the installed package's
[README](../../README.md). Use the detailed reference for
[background shell jobs](../../docs/tools.md#background-shell-jobs).
