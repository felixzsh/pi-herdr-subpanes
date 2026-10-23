import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import {
	truncateToWidth,
	visibleWidth,
	type TUI,
} from "@earendil-works/pi-tui";

import {
	projectLifecycle,
	type LifecycleProjection,
	type SubagentLifecycle,
} from "../../maestro/core/lifecycle.ts";
import { formatElapsedDuration } from "../../maestro/core/status.ts";

/**
 * Sole owner of the status widget keys. Both widgets are written in one
 * synchronous pass, shells first, so their order never flips:
 * `setExtensionWidget` deletes and re-inserts a key on every write.
 */
const SHELLS_KEY = "shells-status";
const SUBAGENT_KEY = "subagent-status";
const WIDGET_INTERVAL_MS = 1000;

const ACTIVE_ACCENT = "\x1b[38;2;77;163;255m";
const OPEN_ACCENT = "\x1b[38;2;214;158;46m";
const RST = "\x1b[0m";

/** Minimal shell-job shape the widget renders; the runtime supplies the rest. */
export interface ShellJobWidgetEntry {
	id: string;
	label?: string;
	command?: string;
	startedAt: number;
}

/** Projection input for one running subagent row. */
export interface SubagentWidgetEntry {
	startTime: number;
	name: string;
	agent?: string;
	runtimePlan?: { modelId: string; thinking: string };
	cancelState?: "requested" | "confirmed" | "unconfirmed";
	lifecycle: SubagentLifecycle;
	statusEnabled: boolean;
}

type WidgetUi = Pick<ExtensionContext, "hasUI"> & {
	ui: Pick<ExtensionContext["ui"], "setWidget">;
};

export interface WidgetCoordinatorSources {
	context: () => WidgetUi | undefined;
	subagents: () => SubagentWidgetEntry[];
}

let sources: WidgetCoordinatorSources | undefined;
let shellJobsSource: () => ShellJobWidgetEntry[] = () => [];
let widgetInterval: ReturnType<typeof setInterval> | null = null;
let shellsWritten = false;
let subagentsWritten = false;
let writtenContext: WidgetUi | undefined;

/** Inject the shell-job feed; phase 3 connects this to the real runtime. */
export function setShellJobsSource(source: () => ShellJobWidgetEntry[]): void {
	shellJobsSource = source;
}

/** Wire the coordinator to its UI context and subagent projection. */
export function configureWidgets(next: WidgetCoordinatorSources): void {
	stopWidgetTimer();
	clearWrittenWidgets();
	sources = next;
}

export function isWidgetTimerRunning(): boolean {
	return widgetInterval !== null;
}

/** Write both widget keys in one synchronous pass, then maintain one timer. */
export function refreshWidgets(): void {
	const context = sources?.context();
	if (!sources || !context?.hasUI) {
		stopWidgetTimer();
		shellsWritten = false;
		subagentsWritten = false;
		writtenContext = undefined;
		return;
	}

	const jobs = shellJobsSource();
	const agents = sources.subagents();

	if (jobs.length > 0) {
		context.ui.setWidget(
			SHELLS_KEY,
			(_tui: TUI, _theme: Theme) => ({
				invalidate() {},
				render(width: number) {
					return renderShellWidgetLines(jobs, width);
				},
			}),
			{ placement: "aboveEditor" },
		);
		shellsWritten = true;
	} else if (shellsWritten) {
		context.ui.setWidget(SHELLS_KEY, undefined);
		shellsWritten = false;
	}

	if (agents.length > 0) {
		context.ui.setWidget(
			SUBAGENT_KEY,
			(_tui: TUI, _theme: Theme) => ({
				invalidate() {},
				render(width: number) {
					return renderSubagentWidgetLines(agents, width);
				},
			}),
			{ placement: "aboveEditor" },
		);
		subagentsWritten = true;
	} else if (subagentsWritten) {
		context.ui.setWidget(SUBAGENT_KEY, undefined);
		subagentsWritten = false;
	}

	writtenContext = shellsWritten || subagentsWritten ? context : undefined;

	if (jobs.length === 0 && agents.length === 0) stopWidgetTimer();
	else startWidgetTimer();
}

/**
 * Stop the timer and reset the write flags. Deliberately does not touch the UI:
 * Pi clears extension widgets on session reset/reload, so the shutdown handler
 * must not assume any UI capability.
 */
export function stopWidgets(): void {
	stopWidgetTimer();
	shellsWritten = false;
	subagentsWritten = false;
	writtenContext = undefined;
}

/** Clear both keys in the context that registered them, then forget that context. */
function clearWrittenWidgets(): void {
	const context = writtenContext;
	writtenContext = undefined;
	shellsWritten = false;
	subagentsWritten = false;
	if (!context) return;
	context.ui.setWidget(SHELLS_KEY, undefined);
	context.ui.setWidget(SUBAGENT_KEY, undefined);
}

function startWidgetTimer(): void {
	if (widgetInterval) return;
	widgetInterval = setInterval(refreshWidgets, WIDGET_INTERVAL_MS);
}

function stopWidgetTimer(): void {
	if (!widgetInterval) return;
	clearInterval(widgetInterval);
	widgetInterval = null;
}

function formatElapsedMMSS(startTime: number, endTime = Date.now()): string {
	const seconds = Math.floor((endTime - startTime) / 1000);
	const m = Math.floor(seconds / 60);
	const s = seconds % 60;
	return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

/**
 * Build a bordered content line: │left          right│
 * Left content is truncated if needed, right is preserved, padded to fill width.
 */
export function borderLine(
	left: string,
	right: string,
	width: number,
	accent = ACTIVE_ACCENT,
): string {
	if (width <= 0) return "";
	if (width === 1) return `${accent}│${RST}`;

	// width = total visible chars for the whole line including │ and │
	const contentWidth = Math.max(0, width - 2); // space inside the two │ chars
	const rightVis = visibleWidth(right);

	// If the status chunk alone is too wide, prefer preserving it in compact form
	// rather than overflowing the terminal.
	if (rightVis >= contentWidth) {
		const truncRight = truncateToWidth(right, contentWidth);
		const rightPad = Math.max(0, contentWidth - visibleWidth(truncRight));
		return `${accent}│${RST}${truncRight}${" ".repeat(rightPad)}${accent}│${RST}`;
	}

	const maxLeft = Math.max(0, contentWidth - rightVis);
	const truncLeft = truncateToWidth(left, maxLeft);
	const leftVis = visibleWidth(truncLeft);
	const pad = Math.max(0, contentWidth - leftVis - rightVis);
	return `${accent}│${RST}${truncLeft}${" ".repeat(pad)}${right}${accent}│${RST}`;
}

/**
 * Build the bordered top line: ╭─ Title ──── info ─╮
 * All chars are accounted for within `width`.
 */
export function borderTop(
	title: string,
	info: string,
	width: number,
	accent = ACTIVE_ACCENT,
): string {
	if (width <= 0) return "";
	if (width === 1) return `${accent}╭${RST}`;

	const inner = Math.max(0, width - 2); // inside ╭ and ╮
	const titlePart = `─ ${title} `;
	const infoPart = info ? ` ${info} ─` : "─";
	const fillLen = Math.max(0, inner - titlePart.length - infoPart.length);
	const fill = "─".repeat(fillLen);
	const content = `${titlePart}${fill}${infoPart}`
		.slice(0, inner)
		.padEnd(inner, "─");
	return `${accent}╭${content}╮${RST}`;
}

/**
 * Build the bordered bottom line: ╰──────────────────╯
 */
export function borderBottom(width: number, accent = ACTIVE_ACCENT): string {
	if (width <= 0) return "";
	if (width === 1) return `${accent}╰${RST}`;

	const inner = Math.max(0, width - 2);
	return `${accent}╰${"─".repeat(inner)}╯${RST}`;
}

function formatLifecycleWidgetLabel(
	projection: LifecycleProjection,
	now: number,
): string {
	const duration =
		projection.stateDurationSince == null
			? ""
			: ` ${formatElapsedDuration(now - projection.stateDurationSince)}`;
	if (projection.kind === "active")
		return projection.label
			? ` active · ${projection.label}${duration} `
			: ` active${duration} `;
	if (projection.kind === "blocked") return ` blocked${duration} `;
	if (projection.kind === "running") return " running… ";
	if (projection.kind === "waiting") return ` waiting${duration} `;
	if (projection.kind === "interrupted") return ` interrupted${duration} `;
	if (projection.kind === "stalled") return ` stalled${duration} `;
	// completed/failed exist as lifecycle projections for delivery bookkeeping,
	// but the row is removed immediately after result delivery — so the only
	// visible terminal handoff label is finalizing.
	if (
		projection.kind === "finalizing" ||
		projection.kind === "completed" ||
		projection.kind === "failed"
	) {
		return " finalizing… ";
	}
	return " starting… ";
}

export function renderSubagentWidgetLines(
	agents: readonly SubagentWidgetEntry[],
	width: number,
): string[] {
	const now = Date.now();
	const rendered = agents.map((agent) => ({
		agent,
		projection: projectLifecycle(agent.lifecycle, now),
	}));
	const activeCount = rendered.filter(
		({ projection }) =>
			projection.kind === "active" ||
			projection.kind === "starting" ||
			projection.kind === "running" ||
			projection.kind === "blocked",
	).length;
	const openCount = agents.length - activeCount;
	const info =
		activeCount > 0
			? openCount > 0
				? `${activeCount} active · ${openCount} open`
				: `${activeCount} active`
			: `${openCount} open`;
	const accent = activeCount > 0 ? ACTIVE_ACCENT : OPEN_ACCENT;

	const lines: string[] = [borderTop("Subagents", info, width, accent)];

	for (const { agent, projection } of rendered) {
		const elapsed = formatElapsedMMSS(
			agent.startTime,
			projection.runtimeEndedAt ?? now,
		);
		const agentTag = agent.agent ? ` (${agent.agent})` : "";
		const left = ` ${elapsed}  ${agent.name}${agentTag} `;
		const runtimeTag = agent.runtimePlan
			? `${agent.runtimePlan.modelId}|${agent.runtimePlan.thinking} · `
			: "";
		const label =
			agent.cancelState === "unconfirmed"
				? "cancel unconfirmed"
				: agent.cancelState
					? "cancelling…"
					: undefined;
		const right = label
			? ` ${runtimeTag}${label} `
			: agent.statusEnabled
				? ` ${runtimeTag}${formatLifecycleWidgetLabel(projection, now).trim()} `
				: ` ${runtimeTag}starting… `;

		lines.push(borderLine(left, right, width, accent));
	}

	lines.push(borderBottom(width, accent));
	return lines;
}

export function renderShellWidgetLines(
	jobs: readonly ShellJobWidgetEntry[],
	width: number,
	now = Date.now(),
): string[] {
	const lines: string[] = [
		borderTop(`shells · ${jobs.length} running`, "", width),
	];

	for (const job of jobs) {
		const elapsed = formatElapsedMMSS(job.startedAt, now);
		const label = job.label ?? job.command ?? "";
		const left = ` ${elapsed}  ${label} `;
		const right = ` ${job.id} `;
		lines.push(borderLine(left, right, width));
	}

	lines.push(borderBottom(width));
	return lines;
}
