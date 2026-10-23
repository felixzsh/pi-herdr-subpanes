import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { __herdrTest__ } from "../../maestro/surfaces/herdr/herdr.ts";
import {
	placeSurface,
	type PlacedSurface,
	type PlaceSurfaceRequest,
} from "../../maestro/surfaces/herdr/placement.ts";

const workspaceId = "workspace-1";

type JsonValue = string | number | boolean | null | JsonObject | JsonValue[];
interface JsonObject {
	readonly [key: string]: JsonValue | undefined;
}

type TestTab = {
	tab_id: string;
	workspace_id: string;
	label: string;
	number: number;
	pane_count: number;
};

type TestPane = {
	pane_id: string;
	tab_id: string;
	workspace_id: string;
};

function json(result: JsonObject): string {
	return `${JSON.stringify({ result })}\n`;
}

function tab(
	tabId: string,
	label: string,
	number: number,
	paneCount: number,
): TestTab {
	return {
		tab_id: tabId,
		workspace_id: workspaceId,
		label,
		number,
		pane_count: paneCount,
	};
}

function pane(paneId: string, tabId: string): TestPane {
	return { pane_id: paneId, tab_id: tabId, workspace_id: workspaceId };
}

interface Harness {
	calls: string[][];
	exec: (args: string[]) => string;
}

function harness(options: {
	tabs?: TestTab[];
	panes?: TestPane[];
	checkoutPath?: string;
}): Harness {
	const calls: string[][] = [];
	const tabs = [...(options.tabs ?? [])];
	const panes = [...(options.panes ?? [])];
	const checkoutPath = options.checkoutPath ?? "/repo";
	let nextTab = tabs.length + 1;
	let nextPane = panes.length + 1;
	let nextNumber = Math.max(0, ...tabs.map((existing) => existing.number)) + 1;

	function exec(args: string[]): string {
		calls.push(args);
		if (args[0] === "pane" && args[1] === "current") {
			return json({
				pane: {
					pane_id: "caller-pane",
					tab_id: "caller-tab",
					workspace_id: workspaceId,
				},
			});
		}
		if (args[0] === "workspace" && args[1] === "list") {
			return json({
				type: "workspace_list",
				workspaces: [
					{
						workspace_id: workspaceId,
						worktree: { checkout_path: checkoutPath },
					},
				],
			});
		}
		if (args[0] === "tab" && args[1] === "list") {
			return json({ type: "tab_list", tabs });
		}
		if (args[0] === "pane" && args[1] === "list") {
			return json({ type: "pane_list", panes });
		}
		if (args[0] === "tab" && args[1] === "create") {
			const label = args[args.indexOf("--label") + 1];
			const tabId = `created-tab-${nextTab++}`;
			const paneId = `created-pane-${nextPane++}`;
			tabs.push(tab(tabId, label, nextNumber++, 1));
			panes.push(pane(paneId, tabId));
			return json({
				tab: { tab_id: tabId },
				root_pane: { pane_id: paneId },
			});
		}
		if (args[0] === "pane" && args[1] === "split") {
			const anchor = panes.find((candidate) => candidate.pane_id === args[2]);
			assert.ok(anchor, "split must target a live pane");
			const tabId = anchor.tab_id;
			const target = tabs.find((candidate) => candidate.tab_id === tabId);
			assert.ok(target, "split must target a live tab");
			const paneId = `created-pane-${nextPane++}`;
			panes.push(pane(paneId, tabId));
			target.pane_count++;
			return json({ pane: { pane_id: paneId } });
		}
		return json({ ok: true });
	}

	return { calls, exec };
}

function request(
	overrides: Partial<PlaceSurfaceRequest> = {},
): PlaceSurfaceRequest {
	return {
		family: "agents",
		name: "child",
		cwd: "/repo",
		maxPerTab: 2,
		direction: "down",
		...overrides,
	};
}

function launches(calls: string[][]): string[][] {
	return calls.filter(
		(args) =>
			(args[0] === "tab" && args[1] === "create") ||
			(args[0] === "pane" && args[1] === "split"),
	);
}

function createdTabs(calls: string[][]): string[][] {
	return calls.filter((args) => args[0] === "tab" && args[1] === "create");
}

function splits(calls: string[][]): string[][] {
	return calls.filter((args) => args[0] === "pane" && args[1] === "split");
}

describe("placeSurface", () => {
	it("adopts an existing family tab instead of creating a new one", async () => {
		const fixture = harness({
			tabs: [tab("agents-tab", "Agents", 1, 1)],
			panes: [pane("pane-1", "agents-tab")],
		});
		let placed: PlacedSurface | undefined;
		await __herdrTest__.withMockHerdrExec(fixture.exec, () => {
			placed = placeSurface(request({ maxPerTab: 2 }));
		});
		assert.deepEqual(placed, {
			paneId: "created-pane-2",
			tabId: "agents-tab",
			workspaceId,
		});
		assert.equal(createdTabs(fixture.calls).length, 0);
		assert.equal(splits(fixture.calls).length, 1);
	});

	it("splits the last live pane with the requested direction", async () => {
		const fixture = harness({
			tabs: [tab("agents-tab", "Agents", 1, 2)],
			panes: [pane("pane-1", "agents-tab"), pane("pane-2", "agents-tab")],
		});
		await __herdrTest__.withMockHerdrExec(fixture.exec, () => {
			placeSurface(request({ maxPerTab: 4, direction: "right" }));
		});
		assert.deepEqual(splits(fixture.calls), [
			[
				"pane",
				"split",
				"pane-2",
				"--direction",
				"right",
				"--no-focus",
				"--cwd",
				"/repo",
			],
		]);
		assert.equal(createdTabs(fixture.calls).length, 0);
	});

	it("creates the next family tab when every candidate is full", async () => {
		const fixture = harness({
			tabs: [tab("agents-tab", "Agents", 1, 2)],
			panes: [pane("pane-1", "agents-tab"), pane("pane-2", "agents-tab")],
		});
		let placed: PlacedSurface | undefined;
		await __herdrTest__.withMockHerdrExec(fixture.exec, () => {
			placed = placeSurface(request({ maxPerTab: 2 }));
		});
		assert.deepEqual(placed, {
			paneId: "created-pane-3",
			tabId: "created-tab-2",
			workspaceId,
		});
		assert.deepEqual(createdTabs(fixture.calls), [
			[
				"tab",
				"create",
				"--workspace",
				workspaceId,
				"--label",
				"Agents 2",
				"--cwd",
				"/repo",
				"--no-focus",
			],
		]);
		assert.equal(splits(fixture.calls).length, 0);
	});

	it("never adopts a tab from the other family", async () => {
		const shells = harness({
			tabs: [tab("shells-tab", "shells", 1, 1)],
			panes: [pane("shells-pane", "shells-tab")],
		});
		await __herdrTest__.withMockHerdrExec(shells.exec, () => {
			placeSurface(request({ family: "agents", maxPerTab: 4 }));
		});
		assert.equal(splits(shells.calls).length, 0);
		assert.equal(createdTabs(shells.calls)[0][5], "Agents");

		const agents = harness({
			tabs: [tab("agents-tab", "Agents", 1, 1)],
			panes: [pane("agents-pane", "agents-tab")],
		});
		await __herdrTest__.withMockHerdrExec(agents.exec, () => {
			placeSurface(request({ family: "shells", maxPerTab: 4 }));
		});
		assert.equal(splits(agents.calls).length, 0);
		assert.equal(createdTabs(agents.calls)[0][5], "shells");
	});

	it("uses dash numbering for the shells family", async () => {
		const fixture = harness({
			tabs: [tab("shells-tab", "shells", 1, 1)],
			panes: [pane("shells-pane", "shells-tab")],
		});
		let placed: PlacedSurface | undefined;
		await __herdrTest__.withMockHerdrExec(fixture.exec, () => {
			placed = placeSurface(request({ family: "shells", maxPerTab: 1 }));
		});
		assert.deepEqual(placed, {
			paneId: "created-pane-2",
			tabId: "created-tab-2",
			workspaceId,
		});
		assert.equal(createdTabs(fixture.calls)[0][5], "shells-2");
	});

	it("launches every surface with --no-focus", async () => {
		const fixture = harness({
			tabs: [tab("agents-tab", "Agents", 1, 1)],
			panes: [pane("pane-1", "agents-tab")],
		});
		await __herdrTest__.withMockHerdrExec(fixture.exec, () => {
			// First call fills the tab, second overflows into a new one.
			placeSurface(request({ maxPerTab: 1 }));
			placeSurface(request({ maxPerTab: 1 }));
		});
		const issued = launches(fixture.calls);
		assert.equal(issued.length, 2);
		for (const args of issued)
			assert.ok(args.includes("--no-focus"), args.join(" "));
	});

	it("orders candidate tabs by family label index, not tab number", async () => {
		const fixture = harness({
			tabs: [
				tab("agents-two", "Agents 2", 1, 1),
				tab("agents-one", "Agents", 2, 1),
			],
			panes: [pane("pane-two", "agents-two"), pane("pane-one", "agents-one")],
		});
		let placed: PlacedSurface | undefined;
		await __herdrTest__.withMockHerdrExec(fixture.exec, () => {
			placed = placeSurface(request({ maxPerTab: 4 }));
		});
		assert.equal(placed?.tabId, "agents-one");
		assert.equal(splits(fixture.calls).length, 1);
		assert.equal(splits(fixture.calls)[0][2], "pane-one");
	});

	it("splits below maxPerTab and overflows at it", async () => {
		const fixture = harness({
			tabs: [tab("agents-tab", "Agents", 1, 1)],
			panes: [pane("pane-1", "agents-tab")],
		});
		await __herdrTest__.withMockHerdrExec(fixture.exec, () => {
			placeSurface(request({ maxPerTab: 2 }));
			placeSurface(request({ maxPerTab: 2 }));
		});
		// Splits once to fill the tab, then creates one overflow tab.
		assert.equal(splits(fixture.calls).length, 1);
		assert.equal(createdTabs(fixture.calls).length, 1);
	});
});
