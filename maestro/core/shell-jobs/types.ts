/**
 * Shell job domain types and the seams the runtime needs. A shell job is a
 * non-interactive command hosted in a `shells` pane and supervised without
 * model calls; the runtime never touches the Herdr CLI directly.
 */

export type ShellJobState =
	| "running"
	| "succeeded"
	| "failed"
	| "unknown"
	| "cancelled"
	| "error";

export type ShellJobDirection = "right" | "down";

export type ShellJobLogMode = "head" | "tail";

export interface ShellJob {
	id: string;
	command: string;
	cwd: string;
	label?: string;
	/** Pi session that asked for the job. */
	sessionId: string;
	/** Session that asked for the job when the caller is a child. */
	parentSessionId?: string;
	tabId: string;
	paneId: string;
	logPath: string;
	statusPath: string;
	commandPath: string;
	startedAt: number;
	finishedAt?: number;
	exitCode?: number | null;
	state: ShellJobState;
	/**
	 * True once the terminal record was persisted together with the intent to
	 * announce it. Only the session that started the job (`sessionId`), or its
	 * parent once that session is gone, announces a job, and only after
	 * persisting this flag in the same terminal write. Delivery is therefore
	 * at-most-once: an owner that dies between persisting and announcing loses
	 * the notice, which is never delivered twice.
	 */
	notified: boolean;
	note?: string;
}

/** Final marker written atomically by the runner. */
export interface ShellJobMarker {
	exit: number;
	finishedAtMs?: number;
}

export interface ShellJobLogRequest {
	mode?: ShellJobLogMode;
	lines?: number;
	grep?: string;
	maxWindowBytes?: number;
	maxOutputBytes?: number;
}

export interface ShellJobLogFragment {
	text: string;
	/** Lines returned after applying the line limit. */
	lineCount: number;
	/** Lines available after the optional grep filter. */
	matchedLines: number;
	/** True when the file was larger than the read window. */
	windowTruncated: boolean;
	/** True when the rendered text hit the output cap. */
	outputTruncated: boolean;
}

export interface ShellJobPaths {
	root: string;
	jobs: string;
	logs: string;
	status: string;
	commands: string;
	runner: string;
}

export interface ShellJobStore {
	readonly paths: ShellJobPaths;
	ensure(): Promise<void>;
	save(job: ShellJob): Promise<void>;
	get(id: string): Promise<ShellJob | undefined>;
	list(): Promise<ShellJob[]>;
	writeCommand(job: ShellJob, command: string): Promise<void>;
	readMarker(job: ShellJob): ShellJobMarker | undefined;
	/** True once the runner recorded that it began executing the command. */
	readStarted(job: ShellJob): boolean;
	readLog(
		job: ShellJob,
		request?: ShellJobLogRequest,
	): Promise<ShellJobLogFragment>;
	/** Removes finished jobs older than the cutoff. Never touches `running`. */
	prune(now: number, retentionMs?: number): Promise<string[]>;
}

export interface ShellPaneInspection {
	alive: boolean;
	backAtPrompt: boolean;
}

export interface ShellSurfacePlacementRequest {
	family: "shells";
	name: string;
	cwd: string;
	maxPerTab: number;
	direction: ShellJobDirection;
}

export interface ShellSurfacePlacement {
	paneId: string;
	tabId: string;
	workspaceId?: string;
}

/**
 * The only Herdr-facing seam of the shell job runtime. Implementations call
 * `placeSurface({ family: "shells", ... })` and the Herdr CLI driver.
 */
export interface ShellJobSurface {
	place(
		request: ShellSurfacePlacementRequest,
	): ShellSurfacePlacement | Promise<ShellSurfacePlacement>;
	runCommand(paneId: string, command: string): void | Promise<void>;
	closePane(paneId: string): void | Promise<void>;
	inspectPane(
		paneId: string,
	): ShellPaneInspection | Promise<ShellPaneInspection>;
}

/** The parent-facing notice seam, implemented by the extension host. */
export interface ShellJobDelivery {
	deliver(job: ShellJob, preview: string): void;
}

/** An opaque timer handle owned by the clock seam. */
export interface ShellJobTimer {
	cancel(): void;
}

export interface ShellJobClock {
	now(): number;
	every(
		milliseconds: number,
		callback: () => void | Promise<void>,
	): ShellJobTimer;
}

export interface StartShellJobParams {
	command: string;
	cwd?: string;
	label?: string;
}

export interface StartedShellJob {
	id: string;
	tabId: string;
	paneId: string;
	logPath: string;
}
