import { randomBytes } from "node:crypto";
import { readFileSync, rmSync, statSync } from "node:fs";
import * as fsp from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import {
	isBoolean,
	isFiniteNumber,
	isNonEmptyString,
	isRecord,
	isString,
} from "../config/type-guards.ts";
import { ensureRunnerScript } from "./runner.ts";
import type {
	ShellJob,
	ShellJobLogFragment,
	ShellJobLogRequest,
	ShellJobMarker,
	ShellJobPaths,
	ShellJobState,
	ShellJobStore,
} from "./types.ts";

/** Finished jobs and their artifacts are retained for two weeks. */
export const DEFAULT_RETENTION_MS = 14 * 24 * 60 * 60 * 1000;
export const DEFAULT_LOG_LINES = 100;
const MAX_LOG_WINDOW_BYTES = 512 * 1024;
const MAX_LOG_OUTPUT_BYTES = 8 * 1024;
const MIN_LOG_LINES = 1;
const MAX_LOG_LINES = 400;

const SHELL_JOB_STATES: ReadonlySet<string> = new Set<ShellJobState>([
	"running",
	"succeeded",
	"failed",
	"unknown",
	"cancelled",
	"error",
]);

function isShellJobState(value: any): value is ShellJobState {
	return isString(value) && SHELL_JOB_STATES.has(value);
}

/** `$PI_CODING_AGENT_DIR/shells`, or the explicit `PI_SHELLS_DIR` override. */
export function resolveShellsRoot(
	env: NodeJS.ProcessEnv = process.env,
): string {
	const override = env.PI_SHELLS_DIR;
	if (isNonEmptyString(override)) return resolve(override);
	const agentDir = isNonEmptyString(env.PI_CODING_AGENT_DIR)
		? env.PI_CODING_AGENT_DIR
		: join(homedir(), ".pi", "agent");
	return join(agentDir, "shells");
}

function resolveShellJobPaths(root: string): ShellJobPaths {
	return {
		root,
		jobs: join(root, "jobs"),
		logs: join(root, "logs"),
		status: join(root, "status"),
		commands: join(root, "commands"),
		runner: join(root, "runner.sh"),
	};
}

export function newShellJobId(now = Date.now()): string {
	return `sh_${now.toString(36)}_${randomBytes(3).toString("hex")}`;
}

function optionalString(value: any): string | undefined {
	return isString(value) ? value : undefined;
}

export function parseShellJob(value: any): ShellJob | undefined {
	if (!isRecord(value)) return undefined;
	const {
		id,
		command,
		cwd,
		sessionId,
		tabId,
		paneId,
		logPath,
		statusPath,
		commandPath,
		startedAt,
		state,
		notified,
	} = value;
	if (
		!isNonEmptyString(id) ||
		!isString(command) ||
		!isNonEmptyString(cwd) ||
		!isNonEmptyString(sessionId) ||
		!isString(tabId) ||
		!isString(paneId) ||
		!isNonEmptyString(logPath) ||
		!isNonEmptyString(statusPath) ||
		!isNonEmptyString(commandPath) ||
		!isFiniteNumber(startedAt) ||
		!isShellJobState(state) ||
		!isBoolean(notified)
	) {
		return undefined;
	}
	const exitCode = value.exitCode;
	const finishedAt = value.finishedAt;
	const job: ShellJob = {
		id,
		command,
		cwd,
		sessionId,
		tabId,
		paneId,
		logPath,
		statusPath,
		commandPath,
		startedAt,
		state,
		notified,
	};
	const label = optionalString(value.label);
	if (label !== undefined) job.label = label;
	const parentSessionId = optionalString(value.parentSessionId);
	if (parentSessionId !== undefined) job.parentSessionId = parentSessionId;
	if (finishedAt !== undefined) {
		if (!isFiniteNumber(finishedAt)) return undefined;
		job.finishedAt = finishedAt;
	}
	if (exitCode !== undefined) {
		if (exitCode === null) job.exitCode = null;
		else if (isFiniteNumber(exitCode)) job.exitCode = exitCode;
		else return undefined;
	}
	const note = optionalString(value.note);
	if (note !== undefined) job.note = note;
	return job;
}

function parseShellJobMarker(value: any): ShellJobMarker | undefined {
	if (!isRecord(value) || !isFiniteNumber(value.exit)) return undefined;
	const finishedAt = value.finished_at;
	if (isFiniteNumber(finishedAt)) {
		return { exit: value.exit, finishedAtMs: finishedAt * 1000 };
	}
	return { exit: value.exit };
}

function readMarkerFromDisk(statusPath: string): ShellJobMarker | undefined {
	try {
		const marker = parseShellJobMarker(
			JSON.parse(readFileSync(statusPath, "utf8")),
		);
		if (!marker) return undefined;
		if (marker.finishedAtMs !== undefined) return marker;
		// Older or hand-written markers may omit the timestamp; the file mtime is
		// the next best evidence for adoption and orphan grace.
		return { exit: marker.exit, finishedAtMs: statSync(statusPath).mtimeMs };
	} catch {
		return undefined;
	}
}

function clampLines(lines: number | undefined): number {
	if (!isFiniteNumber(lines)) return DEFAULT_LOG_LINES;
	const whole = Math.trunc(lines);
	return Math.min(MAX_LOG_LINES, Math.max(MIN_LOG_LINES, whole));
}

function clampBytes(bytes: number | undefined, max: number): number {
	if (!isFiniteNumber(bytes) || bytes <= 0) return max;
	return Math.min(max, Math.trunc(bytes));
}

/**
 * Cuts `text` to at most `maxBytes` UTF-8 bytes without splitting a codepoint;
 * the result can never exceed the byte cap.
 */
function truncateUtf8(text: string, maxBytes: number): string {
	const buffer = Buffer.from(text, "utf8");
	if (buffer.length <= maxBytes) return text;
	let end = Math.max(0, maxBytes);
	// Back off to the lead byte of the codepoint straddling the cut.
	while (end > 0 && (buffer[end] & 0xc0) === 0x80) end -= 1;
	return buffer.subarray(0, end).toString("utf8");
}

function grepLines(lines: string[], pattern: string | undefined): string[] {
	if (pattern === undefined || pattern === "") return lines;
	let matches: (line: string) => boolean;
	try {
		const regex = new RegExp(pattern, "i");
		matches = (line) => regex.test(line);
	} catch {
		matches = (line) => line.toLowerCase().includes(pattern.toLowerCase());
	}
	return lines.filter(matches);
}

async function readWindow(
	logPath: string,
	mode: "head" | "tail",
	windowBytes: number,
): Promise<{ text: string; windowTruncated: boolean }> {
	let size: number;
	try {
		size = (await fsp.stat(logPath)).size;
	} catch {
		return { text: "", windowTruncated: false };
	}
	const length = Math.min(windowBytes, size);
	if (length === 0) return { text: "", windowTruncated: false };
	const start = mode === "head" ? 0 : size - length;
	const handle = await fsp.open(logPath, "r");
	try {
		const buffer = Buffer.alloc(length);
		await handle.read(buffer, 0, length, start);
		let text = buffer.toString("utf8");
		// A tail window can start mid-line; drop that partial line.
		if (mode === "tail" && size > length) {
			const newline = text.indexOf("\n");
			if (newline >= 0) text = text.slice(newline + 1);
		}
		return { text, windowTruncated: size > length };
	} finally {
		await handle.close();
	}
}

export async function readLogFragment(
	logPath: string,
	request: ShellJobLogRequest = {},
): Promise<ShellJobLogFragment> {
	const mode = request.mode === "head" ? "head" : "tail";
	const lineLimit = clampLines(request.lines);
	const windowBytes = clampBytes(request.maxWindowBytes, MAX_LOG_WINDOW_BYTES);
	const outputBytes = clampBytes(request.maxOutputBytes, MAX_LOG_OUTPUT_BYTES);
	let window: { text: string; windowTruncated: boolean };
	try {
		window = await readWindow(logPath, mode, windowBytes);
	} catch {
		return {
			text: "",
			lineCount: 0,
			matchedLines: 0,
			windowTruncated: false,
			outputTruncated: false,
		};
	}
	const lines = window.text.replace(/\r/g, "").split("\n");
	if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
	const matched = grepLines(lines, request.grep);
	const selected =
		mode === "head" ? matched.slice(0, lineLimit) : matched.slice(-lineLimit);
	const rendered = selected.join("\n");
	const outputTruncated = Buffer.byteLength(rendered, "utf8") > outputBytes;
	const suffix = "… [truncated]";
	return {
		text: outputTruncated
			? `${truncateUtf8(
					rendered,
					Math.max(0, outputBytes - Buffer.byteLength(suffix, "utf8")),
				)}${suffix}`
			: rendered,
		lineCount: selected.length,
		matchedLines: matched.length,
		windowTruncated: window.windowTruncated,
		outputTruncated,
	};
}

function jobFilePath(paths: ShellJobPaths, id: string): string {
	return join(paths.jobs, `${id}.json`);
}

async function readJobFile(file: string): Promise<ShellJob | undefined> {
	try {
		return parseShellJob(JSON.parse(await fsp.readFile(file, "utf8")));
	} catch {
		return undefined;
	}
}

async function listJobs(paths: ShellJobPaths): Promise<ShellJob[]> {
	let names: string[];
	try {
		names = await fsp.readdir(paths.jobs);
	} catch {
		return [];
	}
	const jobs: ShellJob[] = [];
	for (const name of names) {
		if (!name.endsWith(".json")) continue;
		const job = await readJobFile(join(paths.jobs, name));
		if (job) jobs.push(job);
	}
	return jobs;
}

function removeJobFiles(paths: ShellJobPaths, job: ShellJob): void {
	for (const file of [
		jobFilePath(paths, job.id),
		job.logPath,
		job.statusPath,
		`${job.statusPath}.started`,
		job.commandPath,
	]) {
		rmSync(file, { force: true });
	}
}

export interface FileShellJobStoreOptions {
	root?: string;
	env?: NodeJS.ProcessEnv;
}

/**
 * File-backed store under one configurable root. Writes the job record with a
 * temp file plus rename so another session never reads a half-written job.
 */
export function createFileShellJobStore(
	options: FileShellJobStoreOptions = {},
): ShellJobStore {
	const paths = resolveShellJobPaths(
		options.root ?? resolveShellsRoot(options.env),
	);
	return {
		paths,
		async ensure() {
			await Promise.all([
				fsp.mkdir(paths.jobs, { recursive: true }),
				fsp.mkdir(paths.logs, { recursive: true }),
				fsp.mkdir(paths.status, { recursive: true }),
				fsp.mkdir(paths.commands, { recursive: true }),
			]);
			ensureRunnerScript(paths.runner);
		},
		async save(job) {
			const target = jobFilePath(paths, job.id);
			// A unique temp name keeps concurrent writers from clobbering each other.
			const tmp = `${target}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
			await fsp.writeFile(tmp, `${JSON.stringify(job, null, 2)}\n`, "utf8");
			await fsp.rename(tmp, target);
		},
		async get(id) {
			if (!isNonEmptyString(id)) return undefined;
			return readJobFile(jobFilePath(paths, id));
		},
		list() {
			return listJobs(paths);
		},
		async writeCommand(job, command) {
			await fsp.writeFile(job.commandPath, command, {
				encoding: "utf8",
				mode: 0o700,
			});
		},
		readMarker(job) {
			return readMarkerFromDisk(job.statusPath);
		},
		readStarted(job) {
			try {
				readFileSync(`${job.statusPath}.started`);
				return true;
			} catch {
				return false;
			}
		},
		readLog(job, request) {
			return readLogFragment(job.logPath, request);
		},
		async prune(now, retentionMs = DEFAULT_RETENTION_MS) {
			const cutoff = now - retentionMs;
			const removed: string[] = [];
			for (const job of await listJobs(paths)) {
				if (job.state === "running") continue;
				if ((job.finishedAt ?? job.startedAt) > cutoff) continue;
				removeJobFiles(paths, job);
				removed.push(job.id);
			}
			return removed;
		},
	};
}
