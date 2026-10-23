import { realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { isFiniteNumber, isString } from "../../core/config/type-guards.ts";
import {
	extractHerdrPaneId,
	extractHerdrRootPaneId,
	getHerdrCurrentPaneInfo,
	getHerdrParentPaneId,
	herdrExec,
	parseHerdrJson,
} from "./herdr.ts";

export type SurfaceFamily = "agents" | "shells";

export interface PlaceSurfaceRequest {
	family: SurfaceFamily;
	/** Pane title. */
	name: string;
	cwd: string;
	maxPerTab: number;
	direction: "right" | "down";
}

export interface PlacedSurface {
	paneId: string;
	tabId: string;
	workspaceId: string;
}

interface FamilyNaming {
	base: string;
	separator: string;
}

// Both families keep their historical spelling so existing tabs are adopted.
const FAMILY_NAMING = {
	agents: { base: "Agents", separator: " " },
	shells: { base: "shells", separator: "-" },
} satisfies Record<SurfaceFamily, FamilyNaming>;

function familyLabel(family: SurfaceFamily, index: number): string {
	const { base, separator } = FAMILY_NAMING[family];
	return index === 1 ? base : `${base}${separator}${index}`;
}

function familyLabelIndex(
	family: SurfaceFamily,
	label: string,
): number | undefined {
	const { base, separator } = FAMILY_NAMING[family];
	if (label === base) return 1;
	const prefix = `${base}${separator}`;
	if (!label.startsWith(prefix)) return undefined;
	const suffix = label.slice(prefix.length);
	if (!/^[1-9]\d*$/.test(suffix)) return undefined;
	const index = Number(suffix);
	return index >= 2 ? index : undefined;
}

interface HerdrTab {
	tab_id: string;
	label: string;
	number: number;
}

interface HerdrPane {
	pane_id: string;
	tab_id: string;
	workspace_id: string;
}

function canonicalPath(path: string): string {
	try {
		return realpathSync(path);
	} catch {
		return resolve(path);
	}
}

function containsCwd(root: string, cwd: string): boolean {
	const child = relative(root, cwd);
	return (
		child === "" ||
		(child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child))
	);
}

function resolveWorkspaceId(cwd: string): string {
	const callerWorkspace = getHerdrCurrentPaneInfo().workspace_id;
	const parsed = parseHerdrJson(herdrExec(["workspace", "list"]));
	const workspaces = parsed?.result?.workspaces;
	if (parsed?.result?.type !== "workspace_list" || !Array.isArray(workspaces)) {
		throw new Error("Unexpected herdr workspace list output for placement");
	}
	const target = canonicalPath(cwd);
	let workspaceId = callerWorkspace;
	let matchLength = -1;
	for (const workspace of workspaces) {
		if (!isString(workspace?.workspace_id))
			throw new Error("Unexpected herdr workspace identity");
		// Herdr exposes checkout ownership, but no stable non-Git workspace root.
		// A shell's incidental cwd is not a workspace association.
		const checkout = workspace.worktree?.checkout_path;
		if (!isString(checkout)) continue;
		const canonical = canonicalPath(checkout);
		if (
			containsCwd(canonical, target) &&
			(canonical.length > matchLength ||
				(canonical.length === matchLength &&
					workspace.workspace_id === callerWorkspace))
		) {
			workspaceId = workspace.workspace_id;
			matchLength = canonical.length;
		}
	}
	return workspaceId;
}

function listWorkspaceTabs(workspaceId: string): HerdrTab[] {
	const parsed = parseHerdrJson(
		herdrExec(["tab", "list", "--workspace", workspaceId]),
	);
	const tabs = parsed?.result?.tabs;
	if (parsed?.result?.type !== "tab_list" || !Array.isArray(tabs)) {
		throw new Error("Unexpected herdr tab list output for placement");
	}
	// Foreign tabs may omit display fields; only family labels and order matter.
	return tabs.map((tab) => {
		if (!isString(tab?.tab_id)) {
			throw new Error("Unexpected herdr tab identity");
		}
		return {
			tab_id: tab.tab_id,
			label: isString(tab.label) ? tab.label : "",
			number: isFiniteNumber(tab.number) ? tab.number : 0,
		};
	});
}

export function listWorkspacePanes(workspaceId: string): HerdrPane[] {
	const parsed = parseHerdrJson(
		herdrExec(["pane", "list", "--workspace", workspaceId]),
	);
	const panes = parsed?.result?.panes;
	if (
		parsed?.result?.type !== "pane_list" ||
		!Array.isArray(panes) ||
		panes.some(
			(pane) =>
				!isString(pane?.pane_id) ||
				!isString(pane?.tab_id) ||
				!isString(pane?.workspace_id),
		)
	) {
		throw new Error("Unexpected herdr pane list output for placement");
	}
	return panes;
}

function renamePane(paneId: string, name: string): void {
	try {
		herdrExec(["pane", "rename", paneId, name]);
	} catch {
		/* cosmetic */
	}
}

function buildTabCreateArgs(
	name: string,
	cwd: string,
	workspaceId: string,
): string[] {
	return [
		"tab",
		"create",
		"--workspace",
		workspaceId,
		"--label",
		name,
		"--cwd",
		cwd,
		"--no-focus",
	];
}

function buildPaneSplitArgs(
	parentPaneId: string,
	direction: "right" | "down",
	cwd: string,
): string[] {
	return [
		"pane",
		"split",
		parentPaneId,
		"--direction",
		direction,
		"--no-focus",
		"--cwd",
		cwd,
	];
}

/**
 * Places one surface in a dedicated tab for the caller workspace. This is the
 * tab-mode counterpart to {@link placeSurface}; no placement state persists.
 */
export function placeTabSurface({
	name,
	cwd,
}: {
	name: string;
	cwd: string;
}): string {
	// Legacy tab mode targets the caller workspace explicitly; Herdr's
	// implicit default may be another workspace.
	const { workspace_id: workspaceId } = getHerdrCurrentPaneInfo();
	const output = herdrExec(buildTabCreateArgs(name, cwd, workspaceId));
	const paneId = extractHerdrRootPaneId(output, "tab create");
	renamePane(paneId, name);
	return paneId;
}

/**
 * Places one surface as a split of the caller pane. This is the split-mode
 * counterpart to {@link placeSurface}; no placement state persists.
 */
export function placeSplitSurface({
	name,
	direction,
	cwd,
}: {
	name: string;
	direction: "right" | "down";
	cwd: string;
}): string {
	const parentPaneId = getHerdrParentPaneId();
	const output = herdrExec(buildPaneSplitArgs(parentPaneId, direction, cwd));
	const paneId = extractHerdrPaneId(output, "pane split");
	renamePane(paneId, name);
	return paneId;
}

function nextFamilyIndex(family: SurfaceFamily, tabs: HerdrTab[]): number {
	const used = new Set<number>();
	for (const tab of tabs) {
		const index = familyLabelIndex(family, tab.label);
		if (index !== undefined) used.add(index);
	}
	let index = 1;
	while (used.has(index)) index++;
	return index;
}

function compareFamilyTabs(
	family: SurfaceFamily,
	left: HerdrTab,
	right: HerdrTab,
): number {
	const leftIndex = familyLabelIndex(family, left.label) ?? 0;
	const rightIndex = familyLabelIndex(family, right.label) ?? 0;
	return leftIndex - rightIndex || left.number - right.number;
}

function createFamilyTab(
	request: PlaceSurfaceRequest,
	workspaceId: string,
	tabs: HerdrTab[],
): PlacedSurface {
	const label = familyLabel(
		request.family,
		nextFamilyIndex(request.family, tabs),
	);
	const output = herdrExec(buildTabCreateArgs(label, request.cwd, workspaceId));
	const paneId = extractHerdrRootPaneId(output, "tab create");
	const tabId = parseHerdrJson(output)?.result?.tab?.tab_id;
	if (!isString(tabId) || !tabId) {
		// Only the explicitly returned pane is ours to roll back.
		try {
			herdrExec(["pane", "close", paneId]);
		} catch {
			/* preserve parse error */
		}
		throw new Error("Unexpected herdr tab create identity");
	}
	renamePane(paneId, request.name);
	return { paneId, tabId, workspaceId };
}

/**
 * Chooses the only pane-allocating path for host surfaces: adopt a family tab
 * with room and split it, or create the next family tab. Reads Herdr on every
 * call; no placement state survives between calls.
 */
export function placeSurface(request: PlaceSurfaceRequest): PlacedSurface {
	const workspaceId = resolveWorkspaceId(request.cwd);
	const tabs = listWorkspaceTabs(workspaceId)
		.filter((tab) => familyLabelIndex(request.family, tab.label) !== undefined)
		.sort((left, right) => compareFamilyTabs(request.family, left, right));
	const panes = listWorkspacePanes(workspaceId);
	for (const tab of tabs) {
		const live = panes.filter((pane) => pane.tab_id === tab.tab_id);
		if (live.length === 0 || live.length >= request.maxPerTab) continue;
		const anchor = live[live.length - 1];
		const paneId = extractHerdrPaneId(
			herdrExec(
				buildPaneSplitArgs(anchor.pane_id, request.direction, request.cwd),
			),
			"pane split",
		);
		renamePane(paneId, request.name);
		return { paneId, tabId: tab.tab_id, workspaceId };
	}
	return createFamilyTab(request, workspaceId, tabs);
}
