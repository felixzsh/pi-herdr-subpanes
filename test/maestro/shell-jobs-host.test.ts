import "../isolated-agent-dir.ts";

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import type {
	ExtensionAPI,
	ExtensionContext,
	Theme,
} from "@earendil-works/pi-coding-agent";
import { createEventBus } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";

import subagentsModule from "../../pi-extension/subagents/index.ts";
import { createFileShellJobStore } from "../../maestro/core/shell-jobs/state.ts";
import type {
	ShellJob,
	ShellJobClock,
	ShellJobStore,
	ShellJobSurface,
	ShellPaneInspection,
	ShellSurfacePlacementRequest,
} from "../../maestro/core/shell-jobs/types.ts";

interface ToolParams {
	command?: string;
	cwd?: string;
	label?: string;
	action?: "list" | "get" | "log" | "cancel";
	job_id?: string;
	all?: boolean;
	mode?: "head" | "tail";
	lines?: number;
	grep?: string;
}

type ToolUpdate = (text: string) => void;

interface ToolDetails {
	jobId?: string;
	tabId?: string;
	paneId?: string;
	logPath?: string;
	state?: string;
	running?: string[];
	finished?: string[];
}

type WidgetFactory = (
	tui: TUI,
	theme: Theme,
) => {
	render(width: number): string[];
};

interface SentMessageOptions {
	triggerTurn?: boolean;
	deliverAs?: string;
}

type Tool = {
	name: string;
	execute: (
		id: string,
		params: ToolParams,
		signal: AbortSignal | undefined,
		update: ToolUpdate | undefined,
		ctx: ExtensionContext,
	) => Promise<{
		content: Array<{ text: string }>;
		details: ToolDetails;
	}>;
};

interface MockApi {
	api: ExtensionAPI;
	registeredTools: Tool[];
	registeredRenderers: Array<{ name: string }>;
	sentMessages: Array<{
		message: { customType?: string; content?: string };
		options: SentMessageOptions | undefined;
	}>;
	eventHandlers: Map<string, Array<Function>>;
}

function createMockApi(): MockApi {
	const registeredTools: Tool[] = [];
	const registeredRenderers: Array<{ name: string }> = [];
	const sentMessages: Array<{
		message: { customType?: string; content?: string };
		options: SentMessageOptions | undefined;
	}> = [];
	const eventHandlers = new Map<string, Array<Function>>();
	// SAFETY: this fixture implements only the ExtensionAPI members the host
	// exercises; TypeScript cannot verify a partial SDK mock.
	const api = {
		events: createEventBus(),
		on(event: string, handler: Function) {
			const handlers = eventHandlers.get(event) ?? [];
			handlers.push(handler);
			eventHandlers.set(event, handlers);
		},
		registerTool(tool: Tool) {
			registeredTools.push(tool);
		},
		registerCommand() {},
		registerMessageRenderer(name: string) {
			registeredRenderers.push({ name });
		},
		sendMessage(
			message: { customType?: string; content?: string },
			options?: SentMessageOptions,
		) {
			sentMessages.push({ message, options });
		},
		sendUserMessage() {},
		getThinkingLevel() {
			return "medium";
		},
		getAllTools() {
			return [];
		},
		getActiveTools() {
			return [];
		},
	} as any;
	return {
		api,
		registeredTools,
		registeredRenderers,
		sentMessages,
		eventHandlers,
	};
}

interface FakeSurfaceState {
	placements: ShellSurfacePlacementRequest[];
	runCommands: Array<{ paneId: string; command: string }>;
	closed: string[];
	inspection: ShellPaneInspection;
}

function createFakeSurface() {
	const state: FakeSurfaceState = {
		placements: [],
		runCommands: [],
		closed: [],
		inspection: { alive: true, backAtPrompt: false },
	};
	let nextPane = 0;
	const surface: ShellJobSurface = {
		place(request) {
			state.placements.push(request);
			nextPane += 1;
			return { paneId: `pane-${nextPane}`, tabId: "tab-shells" };
		},
		runCommand(paneId, command) {
			state.runCommands.push({ paneId, command });
		},
		closePane(paneId) {
			state.closed.push(paneId);
		},
		inspectPane() {
			return state.inspection;
		},
	};
	return { surface, state };
}

interface FakeContextOptions {
	sessionId?: string;
	sessionFile?: string;
	cwd: string;
	widgetCalls?: Array<{ key: string; content: WidgetFactory }>;
}

function createFakeContext(options: FakeContextOptions): ExtensionContext {
	const widgetCalls = options.widgetCalls ?? [];
	const model = { provider: "fake", id: "plain", reasoning: false };
	// SAFETY: this fixture provides every ExtensionContext member the shell job
	// host path reads; unused SDK surface is intentionally omitted.
	const ctx = {
		cwd: options.cwd,
		hasUI: true,
		model,
		modelRegistry: {
			find: () => undefined,
			getAvailable: () => [],
			getAll: () => [],
			hasConfiguredAuth: () => true,
		},
		ui: {
			notify() {},
			setWidget(key: string, content: WidgetFactory | undefined) {
				if (content) widgetCalls.push({ key, content });
			},
		},
		sessionManager: {
			getSessionId: () => options.sessionId ?? "host-session",
			getSessionFile: () => options.sessionFile,
			getSessionDir: () => options.cwd,
			getLeafId: () => "leaf",
		},
		isProjectTrusted: () => true,
	} as any;
	return ctx;
}

const fakeClock: ShellJobClock = {
	now: () => Date.now(),
	every: () => ({ cancel() {} }),
};

function tool(mock: MockApi, name: string): Tool {
	const found = mock.registeredTools.find(
		(candidate) => candidate.name === name,
	);
	assert.ok(found, `expected tool ${name} to be registered`);
	return found;
}

function startedJob(store: ShellJobStore, id: string) {
	return {
		id,
		command: "npm test",
		cwd: store.paths.root,
		sessionId: "host-session",
		tabId: "tab-old",
		paneId: "pane-old",
		logPath: join(store.paths.logs, `${id}.log`),
		statusPath: join(store.paths.status, `${id}.exit`),
		commandPath: join(store.paths.commands, `${id}.sh`),
		startedAt: Date.now() - 5_000,
		state: "running" as const,
		notified: false,
	};
}

async function writeRunJob(
	store: ReturnType<typeof createFileShellJobStore>,
	id: string,
): Promise<ShellJob> {
	const job = startedJob(store, id);
	await store.ensure();
	await store.save(job);
	return job;
}

describe("shell jobs host wiring", () => {
	let root: string;
	let cwd: string;
	let shellsDir: string;
	let previousShellsDir: string | undefined;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "shell-jobs-host-"));
		cwd = join(root, "work");
		mkdirSync(cwd, { recursive: true });
		shellsDir = join(root, "shells");
		previousShellsDir = process.env.PI_SHELLS_DIR;
		process.env.PI_SHELLS_DIR = shellsDir;
	});

	afterEach(() => {
		if (previousShellsDir === undefined) delete process.env.PI_SHELLS_DIR;
		else process.env.PI_SHELLS_DIR = previousShellsDir;
		delete process.env.PI_SUBAGENT_ID;
		delete process.env.PI_DENY_TOOLS;
		rmSync(root, { recursive: true, force: true });
	});

	it("registers both tools in a parent and in a child", () => {
		const parent = createMockApi();
		subagentsModule(parent.api);
		assert.ok(tool(parent, "bg_shell"));
		assert.ok(tool(parent, "bg_shell_status"));
		assert.equal(
			parent.registeredRenderers.some(
				(renderer) => renderer.name === "bg_shell_result",
			),
			true,
		);

		process.env.PI_SUBAGENT_ID = "child";
		process.env.PI_DENY_TOOLS = "subagent,subagent_interrupt,subagents_list";
		const child = createMockApi();
		subagentsModule(child.api);
		assert.ok(tool(child, "bg_shell"));
		assert.ok(tool(child, "bg_shell_status"));
	});

	it("starts a job and serves list, get, log and cancel", async () => {
		const { surface, state } = createFakeSurface();
		const mock = createMockApi();
		subagentsModule(mock.api, {
			shellJobs: { surface, clock: fakeClock },
		});
		const ctx = createFakeContext({ cwd });
		for (const handler of mock.eventHandlers.get("session_start") ?? [])
			await handler({}, ctx);

		const started = await tool(mock, "bg_shell").execute(
			"call",
			{ command: "npm test", label: "unit" },
			undefined,
			undefined,
			ctx,
		);
		const details = started.details;
		assert.ok(details.jobId);
		assert.ok(details.logPath);
		assert.match(details.jobId, /^sh_/);
		assert.equal(details.tabId, "tab-shells");
		assert.equal(details.paneId, "pane-1");
		assert.ok(details.logPath.startsWith(shellsDir));
		assert.equal(started.content[0].text.includes("do not poll"), true);
		assert.equal(state.placements[0]?.family, "shells");
		assert.equal(state.runCommands[0]?.paneId, "pane-1");
		assert.match(state.runCommands[0]?.command ?? "", /runner\.sh/);

		writeFileSync(details.logPath, "line one\nbuild failed here\nline three\n");

		const listed = await tool(mock, "bg_shell_status").execute(
			"call",
			{ action: "list" },
			undefined,
			undefined,
			ctx,
		);
		assert.match(listed.content[0].text, /running: 1/);

		const got = await tool(mock, "bg_shell_status").execute(
			"call",
			{ action: "get", job_id: details.jobId },
			undefined,
			undefined,
			ctx,
		);
		assert.match(got.content[0].text, /state: running/);
		assert.match(got.content[0].text, /build failed here/);

		const log = await tool(mock, "bg_shell_status").execute(
			"call",
			{
				action: "log",
				job_id: details.jobId,
				mode: "tail",
				lines: 2,
				grep: "failed",
			},
			undefined,
			undefined,
			ctx,
		);
		assert.match(log.content[0].text, /lines=1\/2 grep=failed/);
		assert.match(log.content[0].text, /build failed here/);

		const cancelled = await tool(mock, "bg_shell_status").execute(
			"call",
			{ action: "cancel", job_id: details.jobId },
			undefined,
			undefined,
			ctx,
		);
		assert.match(cancelled.content[0].text, /now cancelled/);
		assert.deepEqual(state.closed, ["pane-1"]);
		assert.equal(
			mock.sentMessages.some(
				({ message }) => message.customType === "bg_shell_result",
			),
			true,
		);

		const after = await tool(mock, "bg_shell_status").execute(
			"call",
			{ action: "list" },
			undefined,
			undefined,
			ctx,
		);
		assert.match(after.content[0].text, /running: 0/);
		assert.match(after.content[0].text, /recent finished: 1/);
	});

	it("resumes this session's running jobs on session_start and feeds the widget", async () => {
		const store = createFileShellJobStore();
		const job = await writeRunJob(store, "sh_resumed_1");
		const widgetCalls: Array<{ key: string; content: WidgetFactory }> = [];
		const { surface } = createFakeSurface();
		const mock = createMockApi();
		subagentsModule(mock.api, {
			shellJobs: { surface, clock: fakeClock },
		});
		const ctx = createFakeContext({ cwd, widgetCalls });
		for (const handler of mock.eventHandlers.get("session_start") ?? [])
			await handler({}, ctx);

		const shellsWidget = widgetCalls.find(
			(call) => call.key === "shells-status",
		);
		assert.ok(shellsWidget, "shells widget must receive resumed jobs");
		const widget = shellsWidget.content;
		// SAFETY: renderShellWidgetLines ignores both UI inputs and only renders by
		// width, so empty stand-ins are sufficient here.
		const tui = {} as TUI;
		// SAFETY: see the TUI stand-in above; the renderer never reads the theme.
		const theme = {} as Theme;
		assert.match(widget(tui, theme).render(80).join("\n"), /sh_resumed_1/);

		const got = await tool(mock, "bg_shell_status").execute(
			"call",
			{ action: "get", job_id: job.id },
			undefined,
			undefined,
			ctx,
		);
		assert.match(got.content[0].text, /state: running/);
	});
});
