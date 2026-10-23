import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";

import { createLifecycle } from "../../maestro/core/lifecycle.ts";
import {
	configureWidgets,
	isWidgetTimerRunning,
	refreshWidgets,
	renderShellWidgetLines,
	renderSubagentWidgetLines,
	setShellJobsSource,
	stopWidgets,
	type ShellJobWidgetEntry,
	type SubagentWidgetEntry,
} from "../../pi-extension/herdr-subpanes/widgets.ts";

type WidgetRecorder = Pick<ExtensionUIContext, "setWidget">;
type WidgetContent = Parameters<WidgetRecorder["setWidget"]>[1] | string[];
type WidgetOptions = Parameters<WidgetRecorder["setWidget"]>[2];

interface WidgetCall {
	key: string;
	content: WidgetContent;
	options?: WidgetOptions;
}

type WidgetUi = { hasUI: boolean; ui: WidgetRecorder };

function fakeContext(calls: WidgetCall[], hasUI = true): WidgetUi {
	return {
		hasUI,
		ui: {
			setWidget(key, content, options) {
				calls.push({ key, content, options });
			},
		},
	};
}

function agentEntry(name: string, startedAt = 5_000): SubagentWidgetEntry {
	return {
		startTime: startedAt,
		name,
		lifecycle: createLifecycle(startedAt),
		statusEnabled: true,
	};
}

function shellJob(id: string): ShellJobWidgetEntry {
	return {
		id,
		command: "npm run build:watch --very-long-command-tail",
		startedAt: 5_000,
	};
}

describe("widget coordinator", () => {
	let calls: WidgetCall[];
	let shellJobs: ShellJobWidgetEntry[];
	let agents: SubagentWidgetEntry[];

	beforeEach(() => {
		calls = [];
		shellJobs = [];
		agents = [];
		setShellJobsSource(() => shellJobs);
		configureWidgets({
			context: () => fakeContext(calls),
			subagents: () => agents,
		});
	});

	afterEach(() => {
		stopWidgets();
		setShellJobsSource(() => []);
	});

	it("writes shells before subagents in one pass", () => {
		shellJobs = [shellJob("job-1")];
		agents = [agentEntry("worker")];

		refreshWidgets();

		assert.deepEqual(
			calls.map((call) => call.key),
			["shells-status", "subagent-status"],
		);
		assert.equal(calls[0]?.options?.placement, "aboveEditor");
		assert.equal(calls[1]?.options?.placement, "aboveEditor");
		assert.equal(isWidgetTimerRunning(), true);
		assert.match(
			renderShellWidgetLines(shellJobs, 80, 5_000).join("\n"),
			/job-1/,
		);
		assert.match(renderSubagentWidgetLines(agents, 80).join("\n"), /worker/);
	});

	it("does not write subagent-status when only shell jobs are active", () => {
		shellJobs = [shellJob("job-1")];
		agents = [];

		refreshWidgets();

		assert.deepEqual(
			calls.map((call) => call.key),
			["shells-status"],
		);
		assert.equal(isWidgetTimerRunning(), true);
	});

	it("clears both keys and stops the timer once nothing is running", () => {
		shellJobs = [shellJob("job-1")];
		agents = [agentEntry("worker")];
		refreshWidgets();
		assert.equal(isWidgetTimerRunning(), true);

		calls.length = 0;
		shellJobs = [];
		agents = [];
		refreshWidgets();

		assert.deepEqual(
			calls.map((call) => call.key),
			["shells-status", "subagent-status"],
		);
		assert.equal(calls[0]?.content, undefined);
		assert.equal(calls[1]?.content, undefined);
		assert.equal(isWidgetTimerRunning(), false);
	});

	it("stops the timer without writing to the UI on shutdown", () => {
		shellJobs = [shellJob("job-1")];
		agents = [agentEntry("worker")];
		refreshWidgets();
		calls.length = 0;

		stopWidgets();

		assert.deepEqual(calls, []);
		assert.equal(isWidgetTimerRunning(), false);
	});

	it("stops the timer when the UI disappears", () => {
		let uiContext: WidgetUi | undefined = fakeContext(calls);
		setShellJobsSource(() => [shellJob("job-1")]);
		configureWidgets({
			context: () => uiContext,
			subagents: () => agents,
		});

		refreshWidgets();
		assert.equal(isWidgetTimerRunning(), true);

		uiContext = undefined;
		shellJobs = [];
		calls.length = 0;
		refreshWidgets();

		assert.deepEqual(calls, []);
		assert.equal(isWidgetTimerRunning(), false);
	});

	it("clears keys registered before a reconfigure", () => {
		shellJobs = [shellJob("job-1")];
		agents = [agentEntry("worker")];
		refreshWidgets();
		assert.equal(isWidgetTimerRunning(), true);
		calls.length = 0;

		setShellJobsSource(() => []);
		configureWidgets({
			context: () => fakeContext(calls),
			subagents: () => [],
		});
		refreshWidgets();

		assert.deepEqual(
			calls.map((call) => call.key),
			["shells-status", "subagent-status"],
		);
		assert.ok(calls.every((call) => call.content === undefined));
		assert.equal(isWidgetTimerRunning(), false);
	});

	it("registers nothing without a UI", () => {
		setShellJobsSource(() => [shellJob("job-1")]);
		configureWidgets({
			context: () => fakeContext(calls, false),
			subagents: () => [agentEntry("worker")],
		});

		refreshWidgets();

		assert.deepEqual(calls, []);
		assert.equal(isWidgetTimerRunning(), false);
	});
});

describe("widget rendering width", () => {
	const widths = [1, 2, 5, 20, 40, 120];

	it("keeps shell rows within the requested width", () => {
		const jobs = [shellJob("job-1"), shellJob("job-2")];
		for (const width of widths) {
			const lines = renderShellWidgetLines(jobs, width, 30_000);
			for (const line of lines) {
				assert.ok(
					visibleWidth(line) <= width,
					`shell line width ${visibleWidth(line)} > ${width}`,
				);
			}
		}
	});

	it("keeps subagent rows within the requested width", () => {
		const agents = [agentEntry("worker"), agentEntry("reviewer", 10_000)];
		for (const width of widths) {
			const lines = renderSubagentWidgetLines(agents, width);
			for (const line of lines) {
				assert.ok(
					visibleWidth(line) <= width,
					`subagent line width ${visibleWidth(line)} > ${width}`,
				);
			}
		}
	});

	it("renders the shell title and id", () => {
		const lines = renderShellWidgetLines([shellJob("job-1")], 80, 5_000);
		const rendered = lines.join("\n");
		assert.match(rendered, /shells · 1 running/);
		assert.match(rendered, /00:00/);
		assert.match(rendered, /job-1/);
	});
});
