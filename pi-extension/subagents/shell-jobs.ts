import type {
	ExtensionAPI,
	MessageRenderer,
} from "@earendil-works/pi-coding-agent";
import { keyHint } from "@earendil-works/pi-coding-agent";
import { Box, Text, truncateToWidth } from "@earendil-works/pi-tui";

import type {
	ShellJob,
	ShellJobDelivery,
	ShellJobState,
} from "../../maestro/core/shell-jobs/types.ts";

const PANE_COMMAND_LIMIT = 60;
const NOTICE_COMMAND_LIMIT = 200;

const PARENT_ACTION =
	"Parent action: Continue the parent task using this result; do not return an empty response.";

function shortCommand(command: string, limit: number): string {
	const oneLine = command.replace(/\s+/g, " ").trim();
	return oneLine.length <= limit ? oneLine : `${oneLine.slice(0, limit)}…`;
}

function jobName(job: ShellJob): string {
	return job.label ? job.label : shortCommand(job.command, PANE_COMMAND_LIMIT);
}

function formatDuration(milliseconds: number): string {
	const total = Math.max(0, Math.floor(milliseconds / 1000));
	if (total < 60) return `${total}s`;
	return `${Math.floor(total / 60)}m ${total % 60}s`;
}

function formatElapsed(job: ShellJob): string {
	return formatDuration((job.finishedAt ?? Date.now()) - job.startedAt);
}

function jobHeadline(job: ShellJob): string {
	const name = jobName(job);
	const elapsed = formatElapsed(job);
	switch (job.state) {
		case "succeeded":
			return `bg_shell "${name}" completed (${elapsed}).`;
		case "failed":
			return `bg_shell "${name}" failed (exit code ${job.exitCode ?? "unknown"}, ${elapsed}).`;
		case "cancelled":
			return `bg_shell "${name}" cancelled (${elapsed}).`;
		case "unknown":
			return `bg_shell "${name}" finished with an unconfirmed result (${elapsed}).`;
		case "error":
			return `bg_shell "${name}" could not start.`;
		default:
			return `bg_shell "${name}" is still running (${elapsed}).`;
	}
}

function noticeFacts(job: ShellJob): string[] {
	const lines: string[] = [];
	if (job.note) lines.push(`${job.note}.`, "");
	lines.push(
		`${shortCommand(job.command, NOTICE_COMMAND_LIMIT)} · ${job.cwd} · exit ${job.exitCode ?? "unknown"}`,
	);
	lines.push(`log: ${job.logPath} · job ${job.id}`);
	return lines;
}

function noticeBody(job: ShellJob, preview: string): string {
	return [
		...noticeFacts(job),
		"",
		`More: bg_shell_status({ action: "log", job_id: "${job.id}", mode: "tail", lines: 200, grep: "..." }).`,
		"",
		preview,
	].join("\n");
}

/** What the box shows: facts and output, without the agent-facing hint. */
export function buildShellJobDisplayBody(
	job: ShellJob,
	preview: string,
): string {
	return [...noticeFacts(job), "", preview].join("\n");
}

/** Full model-facing notice delivered as a steer message. */
export function buildShellJobNotice(job: ShellJob, preview: string): string {
	return [
		jobHeadline(job),
		"",
		noticeBody(job, preview),
		"",
		PARENT_ACTION,
	].join("\n");
}

export interface ShellJobResultDetails {
	jobId: string;
	jobName: string;
	command: string;
	cwd: string;
	state: ShellJobState;
	exitCode: number | null;
	logPath: string;
	durationMs: number;
	resultContent: string;
}

export function shellJobResultDetails(
	job: ShellJob,
	preview: string,
): ShellJobResultDetails {
	return {
		jobId: job.id,
		jobName: jobName(job),
		command: job.command,
		cwd: job.cwd,
		state: job.state,
		exitCode: job.exitCode ?? null,
		logPath: job.logPath,
		durationMs: (job.finishedAt ?? Date.now()) - job.startedAt,
		resultContent: buildShellJobDisplayBody(job, preview),
	};
}

/**
 * Sends one completion notice per job. `steer` reaches the agent at the next
 * turn boundary without cancelling the work already in progress.
 */
export function createShellJobDelivery(
	pi: Pick<ExtensionAPI, "sendMessage">,
): ShellJobDelivery {
	return {
		deliver(job, preview) {
			try {
				pi.sendMessage(
					{
						customType: "bg_shell_result",
						content: buildShellJobNotice(job, preview),
						display: true,
						details: shellJobResultDetails(job, preview),
					},
					{ triggerTurn: true, deliverAs: "steer" },
				);
			} catch {
				// Delivery is best effort; the job file and log remain for recovery.
			}
		},
	};
}

function resultStatus(details: ShellJobResultDetails): string {
	switch (details.state) {
		case "succeeded":
			return "completed";
		case "failed":
			return `failed (exit ${details.exitCode ?? "unknown"})`;
		case "cancelled":
			return "cancelled";
		case "unknown":
			return "unconfirmed result";
		default:
			return "could not start";
	}
}

export const renderShellJobResult: MessageRenderer<ShellJobResultDetails> = (
	message,
	options,
	theme,
) => {
	const details = message.details;
	if (!details) return undefined;

	return {
		invalidate() {},
		render(width: number): string[] {
			const name = details.jobName || details.jobId || "job";
			const elapsed = formatDuration(details.durationMs);
			const failed = details.state === "failed" || details.state === "error";
			const unconfirmed =
				details.state === "unknown" || details.state === "cancelled";
			const icon = unconfirmed
				? theme.fg("warning", "■")
				: failed
					? theme.fg("error", "✗")
					: theme.fg("success", "✓");
			const header = `${icon} ${theme.fg("toolTitle", theme.bold(String(name)))} ${theme.fg("dim", "—")} ${resultStatus(details)} ${theme.fg("dim", `(${elapsed})`)}`;

			const raw = details.resultContent;
			const bodyLines = raw.split("\n");
			const inner = Math.max(1, width - 6);
			const contentLines = [header];

			if (options.expanded) {
				for (const line of bodyLines) {
					contentLines.push(truncateToWidth(line, inner));
				}
			} else {
				for (const line of bodyLines.slice(0, 6)) {
					contentLines.push(theme.fg("dim", truncateToWidth(line, inner)));
				}
				if (bodyLines.length > 6) {
					contentLines.push(
						theme.fg("muted", `… ${bodyLines.length - 6} more lines`),
					);
				}
				contentLines.push(
					theme.fg("muted", keyHint("app.tools.expand", "to expand")),
				);
			}

			const background = failed
				? (text: string) => theme.bg("toolErrorBg", text)
				: (text: string) => theme.bg("toolSuccessBg", text);
			const box = new Box(1, 1, background);
			box.addChild(new Text(contentLines.join("\n"), 0, 0));
			return ["", ...box.render(width)];
		},
	};
};
