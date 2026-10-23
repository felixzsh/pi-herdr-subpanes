import { stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
	DEFAULT_LOG_LINES,
	createFileShellJobStore,
	newShellJobId,
} from "../core/shell-jobs/state.ts";
import type {
	ShellJob,
	ShellJobClock,
	ShellJobDelivery,
	ShellJobDirection,
	ShellJobLogFragment,
	ShellJobLogRequest,
	ShellJobState,
	ShellJobStore,
	ShellJobSurface,
	ShellPaneInspection,
	ShellSurfacePlacement,
	StartedShellJob,
	StartShellJobParams,
} from "../core/shell-jobs/types.ts";
import { FileWakeRegistry, type WakeRegistration } from "../core/wake.ts";

const SWEEP_INTERVAL_MS = 2_000;
const RECONCILE_EVERY_SWEEPS = 5;
const LIVENESS_GRACE_TICKS = 4;
const LIVENESS_FAIL_LIMIT = 2;
/** Prompt observations tolerated before a job with no start evidence is settled. */
const NEVER_STARTED_PROMPT_TICKS = 2;
const PREVIEW_OUTPUT_BYTES = 2_048;
const PREVIEW_LINES = DEFAULT_LOG_LINES;
const PANE_COMMAND_LIMIT = 48;

export interface ShellJobsRuntimeOptions {
	surface: ShellJobSurface;
	sessionId: string;
	cwd: string;
	maxPerTab: number;
	direction: ShellJobDirection;
	store?: ShellJobStore;
	clock?: ShellJobClock;
	delivery?: ShellJobDelivery;
	wakeRegistry?: FileWakeRegistry;
	parentSessionId?: string;
	/**
	 * Child sessions whose completion this process observed. Only such a child's
	 * job may be adopted and announced; after a restart the set is empty, so a
	 * child's job stays running until its owner reports or an operator cancels.
	 */
	observedChildCompletions?: ReadonlySet<string>;
	/** Label of the calling pane, appended to the job pane name. */
	callerLabel?: string;
	/** Herdr binary the runner uses to close its own pane. */
	herdrBin?: string;
	retentionMs?: number;
}

export interface ShellJobsDiagnostics {
	/** Entries the runtime still retains. */
	tracked: number;
	/** Entries with an active watcher. */
	watching: number;
	/** Sweeps completed by this runtime. */
	sweeps: number;
}

export interface ShellJobsRuntime {
	start(params: StartShellJobParams): Promise<StartedShellJob>;
	cancel(id: string): Promise<ShellJob | undefined>;
	list(options?: { all?: boolean }): Promise<ShellJob[]>;
	get(id: string): Promise<ShellJob | undefined>;
	readLog(
		id: string,
		request?: ShellJobLogRequest,
	): Promise<ShellJobLogFragment | undefined>;
	reconcile(): Promise<void>;
	watch(): Promise<void>;
	diagnostics(): ShellJobsDiagnostics;
	close(): void;
}

export function systemShellJobClock(): ShellJobClock {
	return {
		now: () => Date.now(),
		every(milliseconds, callback) {
			const timer = setInterval(() => {
				void (async () => {
					try {
						await callback();
					} catch {
						// A transient filesystem or surface failure must not stop the sweep.
					}
				})();
			}, milliseconds);
			timer.unref?.();
			return { cancel: () => clearInterval(timer) };
		},
	};
}

/**
 * The single authoritative runtime record for one job id. `start`, `cancel`,
 * `tick` and `reconcile` all mutate this object, never a fresh disk copy, so a
 * terminal decision can only be taken against the state everyone else sees.
 */
interface WatchEntry {
	job: ShellJob;
	registration?: WakeRegistration;
	/** True while this runtime watches the job through the wake file or sweep. */
	watching: boolean;
	/** True while `start()` owns the entry before it becomes watchable. */
	starting: boolean;
	ticks: number;
	livenessFails: number;
	promptTicks: number;
	started: boolean;
	/** True while one inspection/finalization pass is in flight for this id. */
	inspecting: boolean;
	/** A wake that arrived during an inspection; re-run when it finishes. */
	pendingWake: boolean;
	/** Serializes finalizations so at most one terminal transition is in flight. */
	finishChain: Promise<void>;
}

function shortCommand(command: string, limit = PANE_COMMAND_LIMIT): string {
	const oneLine = command.replace(/\s+/g, " ").trim();
	return oneLine.length <= limit ? oneLine : `${oneLine.slice(0, limit)}…`;
}

function paneName(job: ShellJob, callerLabel?: string): string {
	const base = job.label ?? shortCommand(job.command);
	const caller = callerLabel?.trim();
	return caller ? `${base} · ${caller}` : base;
}

function shellQuote(value: string): string {
	return `'${value.replace(/'/g, `'\\''`)}'`;
}

function runnerCommand(
	job: ShellJob,
	runnerPath: string,
	herdrBin: string,
): string {
	return [
		"bash",
		shellQuote(runnerPath),
		shellQuote(job.id),
		shellQuote(job.commandPath),
		shellQuote(job.logPath),
		shellQuote(job.statusPath),
		shellQuote(job.cwd),
		shellQuote(job.paneId),
		shellQuote(herdrBin),
	].join(" ");
}

class ShellJobsRuntimeState implements ShellJobsRuntime {
	private readonly surface: ShellJobSurface;
	private readonly store: ShellJobStore;
	private readonly clock: ShellJobClock;
	private readonly delivery: ShellJobDelivery | undefined;
	private readonly wakeRegistry: FileWakeRegistry;
	private readonly sessionId: string;
	private readonly parentSessionId: string | undefined;
	private readonly observedChildCompletions: ReadonlySet<string>;
	private readonly cwd: string;
	private readonly maxPerTab: number;
	private readonly direction: ShellJobDirection;
	private readonly callerLabel: string | undefined;
	private readonly herdrBin: string;
	private readonly retentionMs: number | undefined;
	private readonly entries = new Map<string, WatchEntry>();
	private sweepTimer: ReturnType<ShellJobClock["every"]> | undefined;
	private sweeps = 0;
	private closed = false;

	constructor(options: ShellJobsRuntimeOptions) {
		this.surface = options.surface;
		this.store = options.store ?? createFileShellJobStore();
		this.clock = options.clock ?? systemShellJobClock();
		this.delivery = options.delivery;
		this.wakeRegistry = options.wakeRegistry ?? new FileWakeRegistry();
		this.sessionId = options.sessionId;
		this.parentSessionId = options.parentSessionId;
		this.observedChildCompletions =
			options.observedChildCompletions ?? new Set();
		this.cwd = options.cwd;
		this.maxPerTab = options.maxPerTab;
		this.direction = options.direction;
		this.callerLabel = options.callerLabel;
		this.herdrBin = options.herdrBin ?? "herdr";
		this.retentionMs = options.retentionMs;
	}

	async start(params: StartShellJobParams): Promise<StartedShellJob> {
		const command = params.command.trim();
		if (command === "") throw new Error("Shell job command must not be empty");
		const cwd = resolve(this.cwd, params.cwd ?? ".");
		const id = newShellJobId(this.clock.now());
		const job: ShellJob = {
			id,
			command,
			cwd,
			sessionId: this.sessionId,
			tabId: "",
			paneId: "",
			logPath: join(this.store.paths.logs, `${id}.log`),
			statusPath: join(this.store.paths.status, `${id}.exit`),
			commandPath: join(this.store.paths.commands, `${id}.sh`),
			startedAt: this.clock.now(),
			state: "running",
			notified: false,
		};
		if (params.label !== undefined) job.label = params.label;
		if (this.parentSessionId !== undefined) {
			job.parentSessionId = this.parentSessionId;
		}
		// Reserve the authoritative entry before the first await. JavaScript is
		// single-threaded, so reconcile cannot create a competing entry for this
		// id while placement and launch are still in flight below.
		const entry = this.createEntry(job);
		entry.starting = true;
		this.entries.set(id, entry);
		let placement: ShellSurfacePlacement | undefined;
		let phase: "prepare" | "place" | "start" = "prepare";
		try {
			const info = await stat(cwd).catch(() => undefined);
			if (!info?.isDirectory()) {
				throw new Error(`Shell job cwd is not a directory: ${cwd}`);
			}
			await this.store.ensure();
			this.assertStarting(entry);
			// Persist before touching the surface so another session sees the job.
			await this.store.save(job);
			this.assertStarting(entry);
			phase = "place";
			placement = await this.surface.place({
				family: "shells",
				name: paneName(job, this.callerLabel),
				cwd,
				maxPerTab: this.maxPerTab,
				direction: this.direction,
			});
			this.assertStarting(entry);
			// Saved before launch so the pane reads as busy to every other session.
			job.tabId = placement.tabId;
			job.paneId = placement.paneId;
			phase = "start";
			await this.store.save(job);
			this.assertStarting(entry);
			await this.store.writeCommand(job, command);
			this.assertStarting(entry);
			await this.surface.runCommand(
				job.paneId,
				runnerCommand(job, this.store.paths.runner, this.herdrBin),
			);
			this.assertStarting(entry);
		} catch (error) {
			entry.starting = false;
			if (this.entries.get(id) === entry) this.entries.delete(id);
			// A pane created for an aborted start must not stay behind, but a
			// finalizer that already knew the pane has closed it.
			const closedElsewhere =
				entry.job !== job && entry.job.paneId === placement?.paneId;
			if (placement !== undefined && !closedElsewhere) {
				try {
					await this.surface.closePane(placement.paneId);
				} catch {
					// The pane may already be gone.
				}
			}
			const message = error instanceof Error ? error.message : String(error);
			if (entry.job === job && job.state === "running") {
				const note =
					phase === "place"
						? `failed to place a shells pane: ${message}`
						: phase === "start"
							? `failed to start the command: ${message}`
							: message;
				await this.failStart(job, note);
			} else {
				// A cancel or marker settled the job first; keep that state on disk
				// even if a start write raced with it.
				await this.store.save(entry.job).catch(() => {});
			}
			throw error;
		}

		entry.starting = false;
		this.track(job);
		this.ensureSweep();
		return {
			id: job.id,
			tabId: job.tabId,
			paneId: job.paneId,
			logPath: job.logPath,
		};
	}

	/** Rejects a start whose authoritative job left the running state. */
	private assertStarting(entry: WatchEntry): void {
		if (entry.job.state !== "running") {
			throw new Error(
				`Shell job ${entry.job.id} stopped running during start (${entry.job.state})`,
			);
		}
	}

	async cancel(id: string): Promise<ShellJob | undefined> {
		const entry = await this.entryForId(id);
		if (!entry) return this.store.get(id);
		if (entry.job.state === "running") {
			// An explicit cancel settles immediately instead of waiting for a sweep.
			// Finalize against the shared record while an inspection may still be
			// awaiting the surface; that pass re-checks the job and stands down.
			// An operator cancel is the only way to close a job whose owner died
			// without an observed completion.
			await this.finish(entry, "cancelled", null, undefined, {
				operator: true,
			});
		}
		return entry.job;
	}

	async list(options: { all?: boolean } = {}): Promise<ShellJob[]> {
		const jobs = (await this.store.list()).sort(
			(left, right) => right.startedAt - left.startedAt,
		);
		if (options.all) return jobs;
		return jobs.filter(
			(job) =>
				job.sessionId === this.sessionId ||
				job.parentSessionId === this.sessionId,
		);
	}

	get(id: string): Promise<ShellJob | undefined> {
		return this.store.get(id);
	}

	readLog(
		id: string,
		request?: ShellJobLogRequest,
	): Promise<ShellJobLogFragment | undefined> {
		return this.store.get(id).then((job) => {
			if (!job) return undefined;
			return this.store.readLog(job, request);
		});
	}

	async reconcile(): Promise<void> {
		await this.store.prune(this.clock.now(), this.retentionMs).catch(() => []);
		const jobs = await this.store.list();
		const byId = new Map(jobs.map((job) => [job.id, job]));
		for (const [id, entry] of this.entries) {
			// A starting entry is authoritative for this runtime.
			if (entry.starting) continue;
			const persisted = byId.get(id);
			// Drop the local copy once the shared record is gone or settled; a
			// stale disk read never replaces a terminal local entry. A watcher is
			// no longer authoritative once another session settled its job.
			if (!persisted || persisted.state !== "running") {
				if (entry.watching) this.untrack(id);
				this.entries.delete(id);
			}
		}
		for (const job of jobs) {
			if (job.state !== "running") continue;
			// Watching or settling a foreign job is wasted work: only the owner or
			// an observed child's adopter can act on it.
			if (!this.authorized(job)) continue;
			const entry = this.entries.get(job.id) ?? this.entryFor(job);
			if (entry.starting) continue;
			// This runtime's watcher owns its own jobs and their delivery.
			if (entry.watching) continue;
			const marker = this.store.readMarker(entry.job);
			if (!marker) {
				// An authorized running job with no marker still needs a watcher:
				// reconcile may be the first to see a job started after `watch()`,
				// and adoption without liveness would leave it running forever.
				// The sweep settles it as unknown when its pane is gone or the
				// process is back at the prompt without reporting a result.
				this.track(entry.job);
				this.ensureSweep();
				continue;
			}
			const state: ShellJobState = marker.exit === 0 ? "succeeded" : "failed";
			// Only the owner or an observed child's adopter may persist a terminal
			// state here; a foreign runtime leaves the job to its owner.
			await this.finish(entry, state, marker.exit);
		}
	}

	async watch(): Promise<void> {
		await this.store.ensure();
		for (const job of await this.store.list()) {
			if (job.state === "running" && this.authorized(job)) this.track(job);
		}
		this.ensureSweep();
		await this.reconcile();
	}

	diagnostics(): ShellJobsDiagnostics {
		let watching = 0;
		for (const entry of this.entries.values()) {
			if (entry.watching) watching += 1;
		}
		return { tracked: this.entries.size, watching, sweeps: this.sweeps };
	}

	close(): void {
		this.closed = true;
		this.sweepTimer?.cancel();
		this.sweepTimer = undefined;
		for (const entry of this.entries.values()) {
			entry.registration?.unregister();
		}
		this.entries.clear();
		this.wakeRegistry.close();
	}

	private ensureSweep(): void {
		if (this.sweepTimer || this.closed) return;
		this.sweepTimer = this.clock.every(SWEEP_INTERVAL_MS, () => this.sweep());
	}

	private async sweep(): Promise<void> {
		if (this.closed) return;
		this.sweeps += 1;
		for (const entry of this.entries.values()) {
			if (!entry.watching || entry.job.state !== "running") continue;
			await this.tick(entry);
		}
		if (this.sweeps % RECONCILE_EVERY_SWEEPS === 0) await this.reconcile();
	}

	private createEntry(job: ShellJob): WatchEntry {
		return {
			job,
			watching: false,
			starting: false,
			ticks: 0,
			livenessFails: 0,
			promptTicks: 0,
			started: false,
			inspecting: false,
			pendingWake: false,
			finishChain: Promise.resolve(),
		};
	}

	/**
	 * True when this runtime may persist the job's terminal state: it started the
	 * job, or the job belongs to a child whose completion this process observed.
	 */
	private authorized(job: ShellJob): boolean {
		if (job.sessionId === this.sessionId) return true;
		return (
			job.parentSessionId === this.sessionId &&
			this.observedChildCompletions.has(job.sessionId)
		);
	}

	/** Registers a running job for this runtime, reusing its authoritative entry. */
	private track(job: ShellJob): void {
		const entry = this.entries.get(job.id) ?? this.createEntry(job);
		this.entries.set(job.id, entry);
		if (entry.watching) return;
		entry.watching = true;
		const wake = () => {
			void this.tick(entry).catch(() => {});
		};
		try {
			entry.registration = this.wakeRegistry.register(
				join(this.store.paths.status, job.id),
				wake,
				wake,
			);
		} catch {
			// The 2s sweep covers a failed watcher.
		}
	}

	/** Stops watching a job while keeping its authoritative record in memory. */
	private untrack(id: string): void {
		const entry = this.entries.get(id);
		if (!entry) return;
		entry.registration?.unregister();
		entry.registration = undefined;
		entry.watching = false;
	}

	/** Returns the entry for a job, creating it from disk only when unseen. */
	private entryFor(job: ShellJob): WatchEntry {
		const existing = this.entries.get(job.id);
		if (existing) return existing;
		const entry = this.createEntry(job);
		this.entries.set(job.id, entry);
		return entry;
	}

	private async entryForId(id: string): Promise<WatchEntry | undefined> {
		const existing = this.entries.get(id);
		if (existing) return existing;
		const job = await this.store.get(id);
		if (!job || job.state !== "running") return undefined;
		// A concurrent reader may have registered the job while we awaited disk.
		return this.entryFor(job);
	}

	private async tick(entry: WatchEntry): Promise<void> {
		if (this.closed || !this.entries.has(entry.job.id)) return;
		if (entry.inspecting) {
			// A wake during an inspection is not dropped; it re-runs afterwards.
			entry.pendingWake = true;
			return;
		}
		entry.inspecting = true;
		try {
			await this.inspect(entry);
		} finally {
			entry.inspecting = false;
			if (
				entry.pendingWake &&
				!this.closed &&
				entry.job.state === "running" &&
				this.entries.get(entry.job.id) === entry
			) {
				entry.pendingWake = false;
				await this.tick(entry);
			}
		}
	}

	private async inspect(entry: WatchEntry): Promise<void> {
		const job = entry.job;
		if (job.state !== "running") {
			this.untrack(job.id);
			return;
		}
		const marker = this.store.readMarker(job);
		if (marker) {
			await this.finish(
				entry,
				marker.exit === 0 ? "succeeded" : "failed",
				marker.exit,
			);
			return;
		}
		if (!entry.started && this.store.readStarted(job)) entry.started = true;
		entry.ticks += 1;
		if (entry.ticks <= LIVENESS_GRACE_TICKS) return;
		let inspection: ShellPaneInspection;
		try {
			inspection = await this.surface.inspectPane(job.paneId);
		} catch {
			inspection = { alive: false, backAtPrompt: false };
		}
		// The pane read is slow: re-read the authoritative signals before deciding.
		if (entry.job !== job || job.state !== "running") return;
		const lateMarker = this.store.readMarker(job);
		if (lateMarker) {
			await this.finish(
				entry,
				lateMarker.exit === 0 ? "succeeded" : "failed",
				lateMarker.exit,
			);
			return;
		}
		if (!entry.started && this.store.readStarted(job)) entry.started = true;
		if (!inspection.alive) {
			entry.livenessFails += 1;
			if (entry.livenessFails >= LIVENESS_FAIL_LIMIT) {
				await this.finish(
					entry,
					"unknown",
					null,
					"the Herdr pane disappeared before reporting a result",
				);
			}
			return;
		}
		entry.livenessFails = 0;
		if (!inspection.backAtPrompt) {
			entry.started = true;
			entry.promptTicks = 0;
			return;
		}
		if (entry.started) {
			await this.finish(
				entry,
				"unknown",
				null,
				"the process exited without reporting a result",
			);
			return;
		}
		// No marker and no start evidence after bounded prompt observations: the
		// command never ran, so the job must not stay running forever.
		entry.promptTicks += 1;
		if (entry.promptTicks >= NEVER_STARTED_PROMPT_TICKS) {
			await this.finish(entry, "unknown", null, "the command never started");
		}
	}

	private async failStart(job: ShellJob, note: string): Promise<void> {
		job.state = "error";
		job.finishedAt = this.clock.now();
		job.note = note;
		await this.store.save(job);
	}

	/** Serializes terminal transitions; a later caller sees the settled state. */
	private finish(
		entry: WatchEntry,
		state: ShellJobState,
		exitCode: number | null,
		note?: string,
		options: { operator?: boolean } = {},
	): Promise<void> {
		entry.finishChain = entry.finishChain.then(() =>
			this.applyFinish(entry, state, exitCode, note, options.operator === true),
		);
		return entry.finishChain;
	}

	private async applyFinish(
		entry: WatchEntry,
		state: ShellJobState,
		exitCode: number | null,
		note: string | undefined,
		operator: boolean,
	): Promise<void> {
		const job = entry.job;
		// Idempotent against the shared record: cancel beats an older decision.
		if (job.state !== "running") return;
		// Honor a terminal record another path already persisted, without
		// announcing it: the session that persisted it owns the notice.
		const persisted = await this.store.get(job.id).catch(() => undefined);
		if (persisted && persisted.state !== "running") {
			entry.job = persisted;
			this.untrack(persisted.id);
			return;
		}
		// Authorization is decided only after the asynchronous read. Only the
		// session that started a job announces it, and a parent may adopt a child's
		// job only after this process observed that child finish. A foreign runtime
		// never writes a terminal state, not even without a notice: the live owner
		// would then read a settled record and stay silent, losing the only
		// announcement. A dead owner's job stays running until an explicit
		// `bg_shell_status cancel` (the operator path below).
		const adoptable = this.authorized(job);
		if (!adoptable && !operator) return;
		const now = this.clock.now();
		const willDeliver =
			adoptable && !job.notified && this.delivery !== undefined;
		const finished: ShellJob = {
			...job,
			state,
			exitCode,
			finishedAt: now,
			// Persist the intent to announce in the same write, before delivering.
			notified: willDeliver ? true : job.notified,
		};
		if (note !== undefined) finished.note = note;
		// Persist before publishing. A failed write leaves the job running, so the
		// next sweep retries; nothing was announced yet.
		try {
			await this.store.save(finished);
		} catch {
			return;
		}
		entry.job = finished;
		this.untrack(finished.id);
		if (finished.paneId !== "") {
			try {
				await this.surface.closePane(finished.paneId);
			} catch {
				// The pane may already be gone; finalization must still complete.
			}
		}
		if (!willDeliver || !this.delivery) return;
		let preview = "(no output)";
		try {
			const fragment = await this.store.readLog(finished, {
				mode: "tail",
				lines: PREVIEW_LINES,
				maxOutputBytes: PREVIEW_OUTPUT_BYTES,
			});
			const text = fragment.text.trim();
			if (text !== "") preview = text;
		} catch {
			// Keep the fallback preview; the log remains readable by the parent.
		}
		try {
			this.delivery.deliver(finished, preview);
		} catch {
			// Delivery is best effort; the job record and log remain for recovery.
			return;
		}
	}
}

export function createShellJobsRuntime(
	options: ShellJobsRuntimeOptions,
): ShellJobsRuntime {
	return new ShellJobsRuntimeState(options);
}
