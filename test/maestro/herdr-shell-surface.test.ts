import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { PaneInspection } from "../../maestro/core/types.ts";
import { createHerdrShellJobSurface } from "../../maestro/runtime/herdr-shell-surface.ts";
import type { HerdrPaneProcessInfo } from "../../maestro/surfaces/herdr/herdr.ts";

const shellForeground: PaneInspection = {
	kind: "present",
	agentStatus: "unknown",
	observedAt: 1,
};

function processInfo(
	overrides: Partial<HerdrPaneProcessInfo> = {},
): HerdrPaneProcessInfo {
	return {
		paneId: "pane-1",
		shellPid: 100,
		foregroundProcessGroupId: 200,
		pids: [100, 200],
		foregroundProcesses: [{ pid: 200, name: "bash" }],
		...overrides,
	};
}

function surfaceWith(
	inspection: PaneInspection,
	info: () => HerdrPaneProcessInfo,
) {
	return createHerdrShellJobSurface({
		inspect: async () => inspection,
		processInfo: info,
	});
}

describe("herdr shell job surface", () => {
	it("treats an unknown agent status as back at the prompt when the shell runs", async () => {
		const surface = surfaceWith(shellForeground, () =>
			processInfo({ foregroundProcessGroupId: 100, foregroundProcesses: [] }),
		);
		assert.deepEqual(await surface.inspectPane("pane-1"), {
			alive: true,
			backAtPrompt: true,
		});
	});

	it("keeps the job running while the runner owns the foreground", async () => {
		const surface = surfaceWith(shellForeground, () => processInfo());
		assert.deepEqual(await surface.inspectPane("pane-1"), {
			alive: true,
			backAtPrompt: false,
		});
	});

	it("ignores a misleading idle agent status while the runner is live", async () => {
		const surface = surfaceWith(
			{ kind: "present", agentStatus: "idle", observedAt: 1 },
			() => processInfo(),
		);
		assert.equal((await surface.inspectPane("pane-1")).backAtPrompt, false);
	});

	it("reports a missing pane as gone", async () => {
		const surface = surfaceWith({ kind: "missing" }, () => processInfo());
		assert.deepEqual(await surface.inspectPane("pane-1"), {
			alive: false,
			backAtPrompt: false,
		});
	});

	it("does not treat an unavailable query or process read as death", async () => {
		const unavailable = surfaceWith(
			{ kind: "unavailable", error: "boom" },
			() => processInfo(),
		);
		assert.deepEqual(await unavailable.inspectPane("pane-1"), {
			alive: true,
			backAtPrompt: false,
		});
		const unreadable = surfaceWith(shellForeground, () => {
			throw new Error("process-info failed");
		});
		assert.deepEqual(await unreadable.inspectPane("pane-1"), {
			alive: true,
			backAtPrompt: false,
		});
	});
});
