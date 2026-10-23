import type { PaneInspection } from "../core/types.ts";
import type {
	ShellJobSurface,
	ShellPaneInspection,
} from "../core/shell-jobs/types.ts";
import { placeSurface } from "../surfaces/herdr/placement.ts";
import {
	closePane,
	getPaneProcessInfo,
	inspectPane,
	isTerminalAvailable,
	runInPane,
	type HerdrPaneProcessInfo,
} from "../surfaces/herdr/terminal.ts";

/** Herdr reads the shell job surface needs; tests supply deterministic fakes. */
export interface HerdrShellSurfaceDeps {
	inspect(paneId: string): Promise<PaneInspection>;
	processInfo(paneId: string): HerdrPaneProcessInfo;
}

const defaultDeps: HerdrShellSurfaceDeps = {
	inspect: inspectPane,
	processInfo: getPaneProcessInfo,
};

/**
 * A shell pane has no agent, so `agent_status` is always `unknown`. The prompt
 * is only reachable when the interactive shell owns the foreground process
 * group; while the runner or any of its children holds it, the job is live.
 */
function foregroundIsShell(info: HerdrPaneProcessInfo): boolean {
	return (
		info.shellPid !== undefined &&
		info.foregroundProcessGroupId === info.shellPid
	);
}

export function isShellJobsSurfaceAvailable(): boolean {
	return isTerminalAvailable();
}

export function createHerdrShellJobSurface(
	deps: HerdrShellSurfaceDeps = defaultDeps,
): ShellJobSurface {
	return {
		place(request) {
			const placed = placeSurface({
				family: "shells",
				name: request.name,
				cwd: request.cwd,
				maxPerTab: request.maxPerTab,
				direction: request.direction,
			});
			return {
				paneId: placed.paneId,
				tabId: placed.tabId,
				workspaceId: placed.workspaceId,
			};
		},
		runCommand(paneId, command) {
			runInPane(paneId, command);
		},
		closePane(paneId) {
			closePane(paneId);
		},
		async inspectPane(paneId): Promise<ShellPaneInspection> {
			const inspection = await deps.inspect(paneId);
			if (inspection.kind === "missing") {
				return { alive: false, backAtPrompt: false };
			}
			// An unavailable query is not evidence of death: keep the job running and
			// let the runner's marker settle it.
			if (inspection.kind === "unavailable") {
				return { alive: true, backAtPrompt: false };
			}
			let backAtPrompt = false;
			try {
				backAtPrompt = foregroundIsShell(deps.processInfo(paneId));
			} catch {
				// An unreadable process table is not evidence that the runner exited.
			}
			return { alive: true, backAtPrompt };
		},
	};
}
