import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * The wrapper that runs inside the job pane. Arguments:
 * id commandFile log status cwd paneId herdrBin.
 *
 * The marker it writes is the only authoritative completion signal, so a
 * silent process is never mistaken for a finished one. It closes its own pane
 * and never targets Pi's pane or tab.
 */
export const RUNNER_SCRIPT = `#!/usr/bin/env bash
# pi-herdr-agents shell job runner. Managed by the host; local edits are overwritten.
set +e
JOB="$1"; CMD_FILE="$2"; LOG="$3"; STATUS="$4"; CWD="$5"; PANE="$6"; HERDR_BIN="$7"
mkdir -p "$(dirname "$LOG")" "$(dirname "$STATUS")" 2>/dev/null
: > "$LOG" 2>/dev/null
write_status() {
  printf '{"exit":%s,"finished_at":%s}\\n' "$1" "$(date +%s)" > "$STATUS.tmp.$$" 2>/dev/null
  mv -f "$STATUS.tmp.$$" "$STATUS" 2>/dev/null
}
cd "$CWD" 2>>"$LOG" || {
  printf 'shell job: cannot cd to %s\\n' "$CWD" >>"$LOG"
  write_status 96
  exit 0
}
# Start evidence: the supervisor reads $STATUS.started, so a job that finished
# without a marker is never mistaken for one that never ran.
: > "$STATUS.started" 2>/dev/null
bash "$CMD_FILE" 2>&1 | tee -a "$LOG"
CODE="\${PIPESTATUS[0]}"
write_status "$CODE"
printf '\\n__BG_SHELL_DONE__ %s exit=%s log=%s\\n' "$JOB" "$CODE" "$LOG"
# Close only this job's own pane. The shared shells tab is reused by other
# jobs, so closing the tab would kill their panes. Herdr closes the tab when
# its last pane closes. This wrapper never targets Pi's pane or tab.
if [ -n "$PANE" ] && command -v "$HERDR_BIN" >/dev/null 2>&1; then
  "$HERDR_BIN" pane close "$PANE" >/dev/null 2>&1 || true
fi
exit 0
`;

/** Writes the wrapper only when its content differs. Returns true if written. */
export function ensureRunnerScript(runnerPath: string): boolean {
	try {
		if (readFileSync(runnerPath, "utf8") === RUNNER_SCRIPT) return false;
	} catch {
		// Missing wrapper: write the current one below.
	}
	mkdirSync(dirname(runnerPath), { recursive: true });
	writeFileSync(runnerPath, RUNNER_SCRIPT, { mode: 0o700 });
	chmodSync(runnerPath, 0o700);
	return true;
}
