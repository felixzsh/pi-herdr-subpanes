import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
	RUNNER_SCRIPT,
	ensureRunnerScript,
} from "../../maestro/core/shell-jobs/runner.ts";
import {
	DEFAULT_RETENTION_MS,
	createFileShellJobStore,
	newShellJobId,
	readLogFragment,
	resolveShellsRoot,
} from "../../maestro/core/shell-jobs/state.ts";
import type {
	ShellJob,
	ShellJobClock,
	ShellJobDelivery,
	ShellJobDirection,
	ShellJobStore,
	ShellJobSurface,
	ShellPaneInspection,
	ShellSurfacePlacement,
	ShellSurfacePlacementRequest,
} from "../../maestro/core/shell-jobs/types.ts";
import {
	FileWakeRegistry,
	type WakeRegistration,
} from "../../maestro/core/wake.ts";
import {
	createShellJobsRuntime,
	type ShellJobsRuntime,
} from "../../maestro/runtime/shell-jobs.ts";

interface FakeClock {
	clock: ShellJobClock;
	fire(): Promise<void>;
	advance(milliseconds: number): void;
}

function createFakeClock(start = 1_000_000): FakeClock {
	let current = start;
	const timers: Array<{
		callback: () => void | Promise<void>;
		active: boolean;
	}> = [];
	const clock: ShellJobClock = {
		now: () => current,
		every(_milliseconds, callback) {
			const timer = { callback, active: true };
			timers.push(timer);
			return {
				cancel: () => {
					timer.active = false;
				},
			};
		},
	};
	return {
		clock,
		async fire() {
			for (const timer of timers) {
				if (timer.active) await timer.callback();
			}
		},
		advance(milliseconds) {
			current += milliseconds;
		},
	};
}

interface FakeSurfaceState {
	placements: ShellSurfacePlacementRequest[];
	runCommands: Array<{ paneId: string; command: string }>;
	closed: string[];
	inspected: string[];
	inspection: () => ShellPaneInspection | Promise<ShellPaneInspection>;
	onRun?: (paneId: string) => void | Promise<void>;
	nextPane: number;
}

interface FakeSurfaceHarness {
	surface: ShellJobSurface;
	state: FakeSurfaceState;
}

function createFakeSurface(): FakeSurfaceHarness {
	const state: FakeSurfaceState = {
		placements: [],
		runCommands: [],
		closed: [],
		inspected: [],
		inspection: () => ({ alive: true, backAtPrompt: false }),
		nextPane: 0,
	};
	const surface: ShellJobSurface = {
		place(request) {
			state.placements.push(request);
			state.nextPane += 1;
			return { paneId: `pane-${state.nextPane}`, tabId: "tab-shells" };
		},
		async runCommand(paneId, command) {
			state.runCommands.push({ paneId, command });
			await state.onRun?.(paneId);
		},
		async closePane(paneId) {
			state.closed.push(paneId);
		},
		inspectPane(paneId) {
			state.inspected.push(paneId);
			return state.inspection();
		},
	};
	return { surface, state };
}

interface DeliveredNotice {
	job: ShellJob;
	preview: string;
}

interface DeliveryHarness {
	delivery: ShellJobDelivery;
	deliveries: DeliveredNotice[];
}

function createDelivery(): DeliveryHarness {
	const deliveries: DeliveredNotice[] = [];
	return {
		deliveries,
		delivery: {
			deliver(job, preview) {
				deliveries.push({ job, preview });
			},
		},
	};
}

async function writeMarker(
	job: ShellJob,
	exit: number,
	finishedAtMs: number,
): Promise<void> {
	await writeFile(
		job.statusPath,
		JSON.stringify({ exit, finished_at: Math.floor(finishedAtMs / 1000) }),
	);
}

function makeJob(
	store: ShellJobStore,
	id: string,
	overrides: Partial<ShellJob> = {},
): ShellJob {
	const base: ShellJob = {
		id,
		command: "true",
		cwd: store.paths.root,
		sessionId: "session-child",
		tabId: "tab-1",
		paneId: "pane-1",
		logPath: join(store.paths.logs, `${id}.log`),
		statusPath: join(store.paths.status, `${id}.exit`),
		commandPath: join(store.paths.commands, `${id}.sh`),
		startedAt: 1_000_000,
		state: "running",
		notified: false,
	};
	return Object.assign(base, overrides);
}

interface RuntimeParts {
	surface: ShellJobSurface;
	store: ShellJobStore;
	clock: ShellJobClock;
	delivery?: ShellJobDelivery;
	sessionId?: string;
	parentSessionId?: string;
	callerLabel?: string;
	maxPerTab?: number;
	direction?: ShellJobDirection;
	wakeRegistry?: FileWakeRegistry;
	isSessionLive?: (sessionId: string) => boolean;
}

/**
 * A wake registry whose file watches never fire, so a test drives every tick
 * explicitly and an asynchronous wake cannot race the assertion.
 */
class SilentWakeRegistry extends FileWakeRegistry {
	override register(): WakeRegistration {
		return { watching: true, unregister() {} };
	}
}

interface Deferred<T> {
	promise: Promise<T>;
	resolve(value: T): void;
}

function createDeferred<T>(): Deferred<T> {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((settle) => {
		resolve = settle;
	});
	return { promise, resolve };
}

function createRuntime(parts: RuntimeParts): ShellJobsRuntime {
	return createShellJobsRuntime({
		surface: parts.surface,
		store: parts.store,
		clock: parts.clock,
		delivery: parts.delivery,
		sessionId: parts.sessionId ?? "session-main",
		parentSessionId: parts.parentSessionId,
		cwd: parts.store.paths.root,
		maxPerTab: parts.maxPerTab ?? 3,
		direction: parts.direction ?? "down",
		callerLabel: parts.callerLabel,
		wakeRegistry: parts.wakeRegistry,
		isSessionLive: parts.isSessionLive,
		herdrBin: "herdr-test",
	});
}

describe("shell job state", () => {
	let root: string;
	let store: ShellJobStore;

	beforeEach(async () => {
		root = await mkdtemp(join(tmpdir(), "pi-shell-jobs-"));
		store = createFileShellJobStore({ root });
		await store.ensure();
	});

	afterEach(async () => {
		await rm(root, { recursive: true, force: true });
	});

	it("defaults to the agent directory and honors PI_SHELLS_DIR", () => {
		assert.equal(
			resolveShellsRoot({ PI_CODING_AGENT_DIR: "/tmp/agent" }),
			"/tmp/agent/shells",
		);
		assert.equal(
			resolveShellsRoot({
				PI_CODING_AGENT_DIR: "/tmp/agent",
				PI_SHELLS_DIR: "/tmp/custom-shells",
			}),
			"/tmp/custom-shells",
		);
		assert.equal(
			resolveShellsRoot({}),
			join(homedir(), ".pi", "agent", "shells"),
		);
	});

	it("regenerates the runner only when its content differs", async () => {
		const freshPath = join(root, "nested", "runner.sh");
		assert.equal(ensureRunnerScript(freshPath), true);
		assert.equal(ensureRunnerScript(freshPath), false);
		assert.equal(await readFile(freshPath, "utf8"), RUNNER_SCRIPT);
		const runnerPath = join(root, "runner.sh");
		// store.ensure() already wrote the current wrapper during setup.
		assert.equal(ensureRunnerScript(runnerPath), false);
		await writeFile(runnerPath, "tampered");
		assert.equal(ensureRunnerScript(runnerPath), true);
		assert.equal(await readFile(runnerPath, "utf8"), RUNNER_SCRIPT);
		assert.match(RUNNER_SCRIPT, /PIPESTATUS\[0\]/);
		assert.match(RUNNER_SCRIPT, /__BG_SHELL_DONE__/);
		assert.match(RUNNER_SCRIPT, /\$STATUS\.started/);
	});

	it("reads bounded head, tail and grep log fragments", async () => {
		const logPath = join(store.paths.logs, "sh_log_1.log");
		const lines = Array.from({ length: 20 }, (_, index) => `line ${index + 1}`);
		await writeFile(logPath, lines.join("\n"));

		const head = await readLogFragment(logPath, { mode: "head", lines: 3 });
		assert.equal(head.text, "line 1\nline 2\nline 3");
		assert.equal(head.lineCount, 3);

		const tail = await readLogFragment(logPath, { mode: "tail", lines: 2 });
		assert.equal(tail.text, "line 19\nline 20");

		const grep = await readLogFragment(logPath, {
			mode: "tail",
			lines: 2,
			grep: "line 1[0-9]",
		});
		assert.equal(grep.text, "line 18\nline 19");

		const capped = await readLogFragment(logPath, {
			mode: "head",
			lines: 3,
			maxOutputBytes: 10,
		});
		assert.equal(capped.outputTruncated, true);
		assert.ok(capped.text.endsWith("… [truncated]"));

		const windowed = await readLogFragment(logPath, {
			mode: "tail",
			lines: 20,
			maxWindowBytes: 20,
		});
		assert.equal(windowed.windowTruncated, true);
	});

	it("clamps log limits and truncates multibyte output by bytes", async () => {
		const windowPath = join(store.paths.logs, "sh_window.log");
		await writeFile(windowPath, "a".repeat(700 * 1024));
		const windowed = await readLogFragment(windowPath, {
			mode: "tail",
			lines: 400,
			maxWindowBytes: 10_000_000,
			maxOutputBytes: 10_000_000,
		});
		assert.equal(windowed.windowTruncated, true);
		assert.ok(Buffer.byteLength(windowed.text, "utf8") <= 512 * 1024);

		const multibytePath = join(store.paths.logs, "sh_multibyte.log");
		await writeFile(multibytePath, `日本語${"é".repeat(20_000)}`);
		const capped = await readLogFragment(multibytePath, {
			lines: 400,
			maxOutputBytes: 10_000_000,
		});
		assert.equal(capped.outputTruncated, true);
		assert.ok(Buffer.byteLength(capped.text, "utf8") <= 8 * 1024);

		const tiny = await readLogFragment(multibytePath, {
			lines: 400,
			maxOutputBytes: 64,
		});
		assert.equal(tiny.outputTruncated, true);
		assert.ok(Buffer.byteLength(tiny.text, "utf8") <= 64);
	});

	it("prunes finished jobs but never running ones", async () => {
		const now = 2_000_000;
		const finished = makeJob(store, "sh_finished_1", {
			state: "succeeded",
			startedAt: now - DEFAULT_RETENTION_MS - 5_000,
			finishedAt: now - DEFAULT_RETENTION_MS - 1_000,
		});
		const running = makeJob(store, "sh_running_1", {
			state: "running",
			startedAt: now - DEFAULT_RETENTION_MS - 5_000,
		});
		await store.save(finished);
		await store.save(running);

		const removed = await store.prune(now);
		assert.deepEqual(removed, [finished.id]);
		assert.equal(await store.get(finished.id), undefined);
		assert.notEqual(await store.get(running.id), undefined);
	});

	it("generates job ids in the documented shape", () => {
		const id = newShellJobId(1_000_000);
		assert.match(id, /^sh_[a-z0-9]+_[0-9a-f]{6}$/);
	});
});

describe("shell job runtime", () => {
	let root: string;
	let store: ShellJobStore;

	beforeEach(async () => {
		root = await mkdtemp(join(tmpdir(), "pi-shell-jobs-"));
		store = createFileShellJobStore({ root });
		await store.ensure();
	});

	afterEach(async () => {
		await rm(root, { recursive: true, force: true });
	});

	it("finalizes exit 0 as succeeded and delivers once", async () => {
		const { surface, state } = createFakeSurface();
		const fake = createFakeClock();
		const { delivery, deliveries } = createDelivery();
		state.onRun = async () => {
			const job = (await store.list())[0];
			await writeMarker(job, 0, fake.clock.now());
		};
		const runtime = createRuntime({
			surface,
			store,
			clock: fake.clock,
			delivery,
		});
		try {
			const started = await runtime.start({ command: "echo hi" });
			await fake.fire();
			const job = await runtime.get(started.id);
			assert.equal(job?.state, "succeeded");
			assert.equal(job?.exitCode, 0);
			assert.equal(job?.notified, true);
			assert.equal(deliveries.length, 1);
			assert.equal(deliveries[0].job.id, started.id);
			assert.deepEqual(state.closed, [started.paneId]);
		} finally {
			runtime.close();
		}
	});

	it("finalizes a non-zero exit as failed", async () => {
		const { surface, state } = createFakeSurface();
		const fake = createFakeClock();
		const { delivery } = createDelivery();
		state.onRun = async () => {
			const job = (await store.list())[0];
			await writeMarker(job, 7, fake.clock.now());
		};
		const runtime = createRuntime({
			surface,
			store,
			clock: fake.clock,
			delivery,
		});
		try {
			const started = await runtime.start({ command: "false" });
			await fake.fire();
			const job = await runtime.get(started.id);
			assert.equal(job?.state, "failed");
			assert.equal(job?.exitCode, 7);
		} finally {
			runtime.close();
		}
	});

	it("marks a silent process that returned to the prompt as unknown", async () => {
		const { surface, state } = createFakeSurface();
		const fake = createFakeClock();
		const { delivery, deliveries } = createDelivery();
		const inspections: ShellPaneInspection[] = [
			{ alive: true, backAtPrompt: false },
			{ alive: true, backAtPrompt: true },
		];
		state.inspection = () =>
			inspections.shift() ?? { alive: true, backAtPrompt: true };
		const runtime = createRuntime({
			surface,
			store,
			clock: fake.clock,
			delivery,
		});
		try {
			const started = await runtime.start({ command: "sleep 100" });
			for (let tick = 0; tick < 6; tick++) await fake.fire();
			const job = await runtime.get(started.id);
			assert.equal(job?.state, "unknown");
			assert.equal(job?.exitCode, null);
			assert.equal(deliveries.length, 1);
		} finally {
			runtime.close();
		}
	});

	it("marks a disappeared pane as unknown, never succeeded", async () => {
		const { surface, state } = createFakeSurface();
		const fake = createFakeClock();
		const { delivery } = createDelivery();
		state.inspection = () => ({ alive: false, backAtPrompt: false });
		const runtime = createRuntime({
			surface,
			store,
			clock: fake.clock,
			delivery,
		});
		try {
			const started = await runtime.start({ command: "sleep 100" });
			for (let tick = 0; tick < 6; tick++) await fake.fire();
			const job = await runtime.get(started.id);
			assert.equal(job?.state, "unknown");
		} finally {
			runtime.close();
		}
	});

	it("cancels a running job and closes its pane once", async () => {
		const { surface, state } = createFakeSurface();
		const fake = createFakeClock();
		const { delivery, deliveries } = createDelivery();
		const runtime = createRuntime({
			surface,
			store,
			clock: fake.clock,
			delivery,
		});
		try {
			const started = await runtime.start({ command: "sleep 100" });
			const cancelled = await runtime.cancel(started.id);
			assert.equal(cancelled?.state, "cancelled");
			assert.equal(cancelled?.notified, true);
			assert.equal(deliveries.length, 1);
			assert.deepEqual(state.closed, [started.paneId]);
			await runtime.cancel(started.id);
			assert.equal(deliveries.length, 1);
			assert.deepEqual(state.closed, [started.paneId]);
		} finally {
			runtime.close();
		}
	});

	it("lets the parent adopt a dead owner's job exactly once", async () => {
		const fake = createFakeClock();
		const { surface, state } = createFakeSurface();
		const { delivery, deliveries } = createDelivery();
		const job = makeJob(store, "sh_adopted_1", {
			sessionId: "session-child",
			parentSessionId: "session-parent",
			startedAt: fake.clock.now() - 60_000,
		});
		await store.save(job);
		await writeMarker(job, 0, fake.clock.now() - 20_000);
		const runtime = createRuntime({
			surface,
			store,
			clock: fake.clock,
			delivery,
			sessionId: "session-parent",
			isSessionLive: () => false,
		});
		try {
			await runtime.reconcile();
			const adopted = await runtime.get(job.id);
			assert.equal(adopted?.state, "succeeded");
			assert.equal(adopted?.notified, true);
			assert.equal(deliveries.length, 1);
			assert.deepEqual(state.closed, [job.paneId]);
			await runtime.reconcile();
			assert.equal(deliveries.length, 1);
			assert.deepEqual(state.closed, [job.paneId]);
		} finally {
			runtime.close();
		}
	});

	it("does not adopt or deliver a living owner's job", async () => {
		const fake = createFakeClock();
		const { surface, state } = createFakeSurface();
		const { delivery, deliveries } = createDelivery();
		const job = makeJob(store, "sh_live_owner_1", {
			sessionId: "session-child",
			parentSessionId: "session-parent",
			startedAt: fake.clock.now() - 60_000,
		});
		await store.save(job);
		await writeMarker(job, 0, fake.clock.now() - 20_000);
		const runtime = createRuntime({
			surface,
			store,
			clock: fake.clock,
			delivery,
			sessionId: "session-parent",
			isSessionLive: () => true,
		});
		try {
			await runtime.reconcile();
			await runtime.reconcile();
			assert.equal((await runtime.get(job.id))?.state, "running");
			assert.equal(deliveries.length, 0);
			assert.deepEqual(state.closed, []);
		} finally {
			runtime.close();
		}
	});

	it("finalizes a stale orphan without notifying anyone", async () => {
		const fake = createFakeClock();
		const { surface, state } = createFakeSurface();
		const { delivery, deliveries } = createDelivery();
		const job = makeJob(store, "sh_orphan_1", {
			sessionId: "session-gone",
			startedAt: fake.clock.now() - 120_000,
		});
		await store.save(job);
		await writeMarker(job, 3, fake.clock.now() - 61_000);
		const runtime = createRuntime({
			surface,
			store,
			clock: fake.clock,
			delivery,
			sessionId: "session-parent",
			isSessionLive: () => false,
		});
		try {
			await runtime.reconcile();
			const orphan = await runtime.get(job.id);
			assert.equal(orphan?.state, "failed");
			assert.equal(orphan?.exitCode, 3);
			assert.equal(orphan?.notified, false);
			assert.equal(deliveries.length, 0);
			assert.deepEqual(state.closed, [job.paneId]);
		} finally {
			runtime.close();
		}
	});

	it("does not settle a stale orphan once its owner resumes during the read", async () => {
		const fake = createFakeClock();
		const { surface, state } = createFakeSurface();
		const { delivery, deliveries } = createDelivery();
		const job = makeJob(store, "sh_orphan_resumed_1", {
			sessionId: "session-gone",
			startedAt: fake.clock.now() - 120_000,
		});
		await store.save(job);
		await writeMarker(job, 3, fake.clock.now() - 61_000);
		let live = false;
		const suspending = createDeferred<void>();
		const release = createDeferred<void>();
		let reads = 0;
		const barrierStore: ShellJobStore = {
			...store,
			async get(id) {
				reads += 1;
				if (reads === 1) {
					suspending.resolve();
					await release.promise;
				}
				return store.get(id);
			},
		};
		const runtime = createRuntime({
			surface,
			store: barrierStore,
			clock: fake.clock,
			delivery,
			sessionId: "session-parent",
			isSessionLive: () => live,
		});
		try {
			const settling = runtime.reconcile();
			await suspending.promise;
			// The owner resumes while this finish is suspended on the shared read.
			live = true;
			release.resolve();
			await settling;
			assert.equal((await store.get(job.id))?.state, "running");
			assert.equal(deliveries.length, 0);
			assert.deepEqual(state.closed, []);
			assert.equal(runtime.diagnostics().tracked, 1);
		} finally {
			runtime.close();
		}
	});

	it("does not adopt a child's job once its owner resumes during the read", async () => {
		const fake = createFakeClock();
		const { surface, state } = createFakeSurface();
		const { delivery, deliveries } = createDelivery();
		const job = makeJob(store, "sh_child_resumed_1", {
			sessionId: "session-child",
			parentSessionId: "session-parent",
			startedAt: fake.clock.now() - 120_000,
		});
		await store.save(job);
		await writeMarker(job, 0, fake.clock.now() - 20_000);
		let live = false;
		const suspending = createDeferred<void>();
		const release = createDeferred<void>();
		let reads = 0;
		const barrierStore: ShellJobStore = {
			...store,
			async get(id) {
				reads += 1;
				if (reads === 1) {
					suspending.resolve();
					await release.promise;
				}
				return store.get(id);
			},
		};
		const runtime = createRuntime({
			surface,
			store: barrierStore,
			clock: fake.clock,
			delivery,
			sessionId: "session-parent",
			isSessionLive: () => live,
		});
		try {
			const settling = runtime.reconcile();
			await suspending.promise;
			live = true;
			release.resolve();
			await settling;
			assert.equal((await store.get(job.id))?.state, "running");
			assert.equal(deliveries.length, 0);
			assert.deepEqual(state.closed, []);
			assert.equal(runtime.diagnostics().tracked, 1);
		} finally {
			runtime.close();
		}
	});

	it("sends family, maxPerTab and direction to placement", async () => {
		const { surface, state } = createFakeSurface();
		const fake = createFakeClock();
		const runtime = createRuntime({
			surface,
			store,
			clock: fake.clock,
			callerLabel: "worker",
			maxPerTab: 2,
			direction: "right",
		});
		try {
			await runtime.start({ command: "echo hi", label: "build" });
			assert.deepEqual(state.placements, [
				{
					family: "shells",
					name: "build · worker",
					cwd: root,
					maxPerTab: 2,
					direction: "right",
				},
			]);
			assert.match(state.runCommands[0].command, /runner\.sh/);
			assert.match(state.runCommands[0].command, /herdr-test/);
		} finally {
			runtime.close();
		}
	});

	it("keeps a cancel authoritative over an inspection in flight", async () => {
		const { surface, state } = createFakeSurface();
		const fake = createFakeClock();
		const { delivery, deliveries } = createDelivery();
		const gate = createDeferred<ShellPaneInspection>();
		const inspecting = createDeferred<void>();
		state.inspection = () => {
			inspecting.resolve();
			return gate.promise;
		};
		const runtime = createRuntime({
			surface,
			store,
			clock: fake.clock,
			delivery,
			wakeRegistry: new SilentWakeRegistry(),
		});
		try {
			const started = await runtime.start({ command: "sleep 100" });
			for (let tick = 0; tick < 4; tick++) await fake.fire();
			const blockedTick = fake.fire();
			await inspecting.promise;
			await Promise.all([runtime.reconcile(), runtime.reconcile()]);
			const cancelled = await runtime.cancel(started.id);
			assert.equal(cancelled?.state, "cancelled");
			gate.resolve({ alive: true, backAtPrompt: true });
			await blockedTick;
			await Promise.all([runtime.reconcile(), runtime.reconcile()]);
			const job = await runtime.get(started.id);
			assert.equal(job?.state, "cancelled");
			assert.equal(job?.notified, true);
			assert.equal(deliveries.length, 1);
			assert.deepEqual(state.closed, [started.paneId]);
		} finally {
			runtime.close();
		}
	});

	it("prefers a marker written during an inspection over unknown", async () => {
		const { surface, state } = createFakeSurface();
		const fake = createFakeClock();
		const { delivery, deliveries } = createDelivery();
		const gate = createDeferred<ShellPaneInspection>();
		const inspecting = createDeferred<void>();
		state.inspection = () => {
			inspecting.resolve();
			return gate.promise;
		};
		const runtime = createRuntime({
			surface,
			store,
			clock: fake.clock,
			delivery,
			wakeRegistry: new SilentWakeRegistry(),
		});
		try {
			const started = await runtime.start({ command: "sleep 100" });
			for (let tick = 0; tick < 4; tick++) await fake.fire();
			const blockedTick = fake.fire();
			await inspecting.promise;
			const job = (await store.list())[0];
			await writeMarker(job, 0, fake.clock.now());
			gate.resolve({ alive: true, backAtPrompt: true });
			await blockedTick;
			const settled = await runtime.get(started.id);
			assert.equal(settled?.state, "succeeded");
			assert.equal(settled?.exitCode, 0);
			assert.equal(deliveries.length, 1);
		} finally {
			runtime.close();
		}
	});

	it("settles a job that never started instead of leaving it running", async () => {
		const { surface, state } = createFakeSurface();
		const fake = createFakeClock();
		const { delivery, deliveries } = createDelivery();
		state.inspection = () => ({ alive: true, backAtPrompt: true });
		const runtime = createRuntime({
			surface,
			store,
			clock: fake.clock,
			delivery,
			wakeRegistry: new SilentWakeRegistry(),
		});
		try {
			const started = await runtime.start({ command: "true" });
			for (let tick = 0; tick < 12; tick++) await fake.fire();
			const job = await runtime.get(started.id);
			assert.equal(job?.state, "unknown");
			assert.equal(job?.note, "the command never started");
			assert.equal(deliveries.length, 1);
		} finally {
			runtime.close();
		}
	});

	it("retries a failed terminal write instead of keeping it in memory", async () => {
		const { surface, state } = createFakeSurface();
		const fake = createFakeClock();
		const { delivery, deliveries } = createDelivery();
		let failedOnce = false;
		const flaky: ShellJobStore = {
			...store,
			async save(job) {
				if (job.state !== "running" && !failedOnce) {
					failedOnce = true;
					throw new Error("injected terminal write failure");
				}
				await store.save(job);
			},
		};
		state.onRun = async () => {
			const job = (await store.list())[0];
			await writeMarker(job, 0, fake.clock.now());
		};
		const runtime = createRuntime({
			surface,
			store: flaky,
			clock: fake.clock,
			delivery,
			wakeRegistry: new SilentWakeRegistry(),
		});
		try {
			const started = await runtime.start({ command: "echo hi" });
			await fake.fire();
			assert.equal((await store.get(started.id))?.state, "running");
			assert.equal(deliveries.length, 0);
			assert.deepEqual(state.closed, []);
			// A failed terminal write leaves the job running, so the next sweep retries.
			await fake.fire();
			const job = await store.get(started.id);
			assert.equal(job?.state, "succeeded");
			assert.equal(job?.exitCode, 0);
			assert.equal(deliveries.length, 1);
			assert.deepEqual(state.closed, [started.paneId]);
		} finally {
			runtime.close();
		}
	});

	it("closes the pane and persists error when the pane save fails", async () => {
		const { surface, state } = createFakeSurface();
		const fake = createFakeClock();
		const { delivery, deliveries } = createDelivery();
		let failedOnce = false;
		const flaky: ShellJobStore = {
			...store,
			async save(job) {
				if (job.paneId !== "" && job.state === "running" && !failedOnce) {
					failedOnce = true;
					throw new Error("injected pane save failure");
				}
				await store.save(job);
			},
		};
		const runtime = createRuntime({
			surface,
			store: flaky,
			clock: fake.clock,
			delivery,
			wakeRegistry: new SilentWakeRegistry(),
		});
		try {
			await assert.rejects(
				runtime.start({ command: "sleep 100" }),
				/injected pane save failure/,
			);
			assert.equal(state.closed.length, 1);
			const jobs = await store.list();
			assert.equal(jobs.length, 1);
			assert.equal(jobs[0].state, "error");
			assert.equal(jobs[0].paneId, state.closed[0]);
			await fake.fire();
			await fake.fire();
			assert.equal(state.closed.length, 1);
			assert.equal(deliveries.length, 0);
		} finally {
			runtime.close();
		}
	});

	it("closes the pane and persists error when writeCommand fails", async () => {
		const { surface, state } = createFakeSurface();
		const fake = createFakeClock();
		const { delivery, deliveries } = createDelivery();
		const flaky: ShellJobStore = {
			...store,
			async writeCommand() {
				throw new Error("injected writeCommand failure");
			},
		};
		const runtime = createRuntime({
			surface,
			store: flaky,
			clock: fake.clock,
			delivery,
			wakeRegistry: new SilentWakeRegistry(),
		});
		try {
			await assert.rejects(
				runtime.start({ command: "sleep 100" }),
				/injected writeCommand failure/,
			);
			assert.equal(state.closed.length, 1);
			const jobs = await store.list();
			assert.equal(jobs.length, 1);
			assert.equal(jobs[0].state, "error");
			assert.equal(jobs[0].paneId, state.closed[0]);
			await fake.fire();
			await fake.fire();
			assert.equal(state.closed.length, 1);
			assert.equal(deliveries.length, 0);
		} finally {
			runtime.close();
		}
	});

	it("keeps the reserved entry authoritative while placement is blocked", async () => {
		const { surface, state } = createFakeSurface();
		const fake = createFakeClock();
		const { delivery } = createDelivery();
		const gate = createDeferred<ShellSurfacePlacement>();
		const placing = createDeferred<void>();
		surface.place = (request) => {
			state.placements.push(request);
			placing.resolve();
			return gate.promise;
		};
		const runtime = createRuntime({
			surface,
			store,
			clock: fake.clock,
			delivery,
			wakeRegistry: new SilentWakeRegistry(),
		});
		try {
			const pending = runtime.start({ command: "sleep 100" });
			await placing.promise;
			await runtime.reconcile();
			await runtime.reconcile();
			gate.resolve({ paneId: "pane-blocked", tabId: "tab-shells" });
			const started = await pending;
			assert.equal(started.paneId, "pane-blocked");
			const saved = await runtime.get(started.id);
			assert.equal(saved?.paneId, "pane-blocked");
			for (let tick = 0; tick < 6; tick++) await fake.fire();
			assert.ok(state.inspected.length > 0);
			for (const paneId of state.inspected)
				assert.equal(paneId, "pane-blocked");
			assert.deepEqual(state.closed, []);
			const cancelled = await runtime.cancel(started.id);
			assert.equal(cancelled?.paneId, "pane-blocked");
			assert.deepEqual(state.closed, ["pane-blocked"]);
		} finally {
			runtime.close();
		}
	});

	it("aborts a start cancelled while placement is blocked", async () => {
		const { surface, state } = createFakeSurface();
		const fake = createFakeClock();
		const { delivery } = createDelivery();
		const gate = createDeferred<ShellSurfacePlacement>();
		const placing = createDeferred<void>();
		surface.place = (request) => {
			state.placements.push(request);
			placing.resolve();
			return gate.promise;
		};
		const runtime = createRuntime({
			surface,
			store,
			clock: fake.clock,
			delivery,
			wakeRegistry: new SilentWakeRegistry(),
		});
		try {
			const pending = runtime.start({ command: "sleep 100" });
			await placing.promise;
			const [running] = await store.list();
			const cancelled = await runtime.cancel(running.id);
			assert.equal(cancelled?.state, "cancelled");
			gate.resolve({ paneId: "pane-blocked", tabId: "tab-shells" });
			await assert.rejects(pending, /stopped running during start/);
			const saved = await runtime.get(running.id);
			assert.equal(saved?.state, "cancelled");
			assert.equal(state.runCommands.length, 0);
			assert.deepEqual(state.closed, ["pane-blocked"]);
			assert.ok(!state.inspected.includes(""));
		} finally {
			runtime.close();
		}
	});

	it("delivers exactly once from the owning session", async () => {
		const fake = createFakeClock();
		const { surface, state } = createFakeSurface();
		const { delivery, deliveries } = createDelivery();
		const job = makeJob(store, "sh_owner_1", {
			sessionId: "session-child",
			parentSessionId: "session-parent",
			startedAt: fake.clock.now() - 60_000,
		});
		await store.save(job);
		await writeMarker(job, 0, fake.clock.now() - 20_000);
		const runtime = createRuntime({
			surface,
			store,
			clock: fake.clock,
			delivery,
			sessionId: "session-child",
		});
		try {
			await runtime.reconcile();
			const saved = await runtime.get(job.id);
			assert.equal(saved?.state, "succeeded");
			assert.equal(saved?.notified, true);
			assert.equal(deliveries.length, 1);
			assert.deepEqual(state.closed, [job.paneId]);
			await runtime.reconcile();
			assert.equal(deliveries.length, 1);
			assert.deepEqual(state.closed, [job.paneId]);
		} finally {
			runtime.close();
		}
	});

	it("does not duplicate delivery across overlapping reconciles", async () => {
		const fake = createFakeClock();
		const { surface, state } = createFakeSurface();
		const { delivery, deliveries } = createDelivery();
		const job = makeJob(store, "sh_overlap_1", {
			sessionId: "session-main",
			startedAt: fake.clock.now() - 60_000,
		});
		await store.save(job);
		await writeMarker(job, 0, fake.clock.now() - 20_000);
		// Both reconciliations read the same running snapshot before settling.
		const bothRead = createDeferred<void>();
		let reads = 0;
		const barrierStore: ShellJobStore = {
			...store,
			async list() {
				const jobs = await store.list();
				reads += 1;
				if (reads >= 2) bothRead.resolve();
				await bothRead.promise;
				return jobs;
			},
		};
		const runtime = createRuntime({
			surface,
			store: barrierStore,
			clock: fake.clock,
			delivery,
		});
		try {
			await Promise.all([runtime.reconcile(), runtime.reconcile()]);
			assert.equal(deliveries.length, 1);
			assert.deepEqual(state.closed, [job.paneId]);
			const saved = await store.get(job.id);
			assert.equal(saved?.state, "succeeded");
			assert.equal(saved?.notified, true);
		} finally {
			runtime.close();
		}
	});

	it("never repeats a notice its owner persisted before dying", async () => {
		const fake = createFakeClock();
		const childSurface = createFakeSurface();
		const parentSurface = createFakeSurface();
		const parentDelivery = createDelivery();
		const job = makeJob(store, "sh_notified_1", {
			sessionId: "session-child",
			parentSessionId: "session-parent",
			startedAt: fake.clock.now() - 60_000,
		});
		await store.save(job);
		await writeMarker(job, 0, fake.clock.now() - 20_000);
		const child = createRuntime({
			surface: childSurface.surface,
			store,
			clock: fake.clock,
			delivery: {
				deliver() {
					// The owner dies after persisting the notice, before announcing it.
					throw new Error("owner exited mid-delivery");
				},
			},
			sessionId: "session-child",
			wakeRegistry: new SilentWakeRegistry(),
		});
		try {
			await child.reconcile();
			const persisted = await store.get(job.id);
			assert.equal(persisted?.state, "succeeded");
			assert.equal(persisted?.notified, true);
			assert.deepEqual(childSurface.state.closed, [job.paneId]);
		} finally {
			child.close();
		}
		const parent = createRuntime({
			surface: parentSurface.surface,
			store,
			clock: fake.clock,
			delivery: parentDelivery.delivery,
			sessionId: "session-parent",
			isSessionLive: () => false,
		});
		try {
			await parent.reconcile();
			assert.equal(parentDelivery.deliveries.length, 0);
			assert.deepEqual(parentSurface.state.closed, []);
			assert.equal((await store.get(job.id))?.notified, true);
		} finally {
			parent.close();
		}
	});

	it("drops local entries for jobs another session settled or pruned", async () => {
		const fake = createFakeClock();
		const surface = createFakeSurface();
		const runtimeA = createRuntime({
			surface: surface.surface,
			store,
			clock: fake.clock,
			sessionId: "session-a",
		});
		const runtimeB = createRuntime({
			surface: createFakeSurface().surface,
			store,
			clock: fake.clock,
			sessionId: "session-b",
		});
		try {
			const settled = ["sh_foreign_1", "sh_foreign_2", "sh_foreign_3"];
			for (const id of settled) {
				await store.save(
					makeJob(store, id, {
						sessionId: "session-b",
						startedAt: fake.clock.now(),
					}),
				);
			}
			await runtimeA.reconcile();
			assert.equal(runtimeA.diagnostics().tracked, settled.length);
			for (const id of settled) await runtimeB.cancel(id);
			await runtimeA.reconcile();
			assert.equal(runtimeA.diagnostics().tracked, 0);

			const pruned = ["sh_foreign_4", "sh_foreign_5", "sh_foreign_6"];
			for (const id of pruned) {
				await store.save(
					makeJob(store, id, {
						sessionId: "session-b",
						startedAt: fake.clock.now(),
					}),
				);
			}
			await runtimeA.reconcile();
			assert.equal(runtimeA.diagnostics().tracked, pruned.length);
			for (const id of pruned) await runtimeB.cancel(id);
			await store.prune(fake.clock.now(), 0);
			await runtimeA.reconcile();
			assert.equal(runtimeA.diagnostics().tracked, 0);
		} finally {
			runtimeA.close();
			runtimeB.close();
		}
	});
});
