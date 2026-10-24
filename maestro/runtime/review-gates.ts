import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { isRecord, isString } from "../core/config/type-guards.ts";

/**
 * One completed ordinary run kept as an idempotency gate. A later identical
 * request (same parent, agent, name, task) with the same tree fingerprint
 * reuses this verdict instead of launching a new child.
 */
export interface ReviewGate {
	key: string;
	agent?: string;
	name: string;
	taskSha: string;
	cwd: string;
	tree: string;
	completedAt: string;
	verdict?: string;
	summary: string;
	childSessionFile: string;
	model?: string;
}

export interface ReviewGateStore {
	version: 1;
	gates: Record<string, ReviewGate>;
}

const GATE_FILE_SUFFIX = ".gates.json";
const STORE_VERSION = 1;
const SUMMARY_CAP = 4000;

export function taskSha(task: string): string {
	return createHash("sha256").update(task, "utf8").digest("hex");
}

/** Stable identity for "the same request": parent session is the file scope. */
export function gateKey(input: {
	agent?: string;
	name: string;
	task: string;
}): string {
	return createHash("sha256")
		.update(
			[input.agent ?? "", input.name, taskSha(input.task)].join("\n"),
			"utf8",
		)
		.digest("hex");
}

export type GitRunner = (args: string[], cwd: string) => string;

function defaultGitRunner(args: string[], cwd: string): string {
	return execFileSync("git", args, {
		cwd,
		timeout: 15000,
		stdio: ["ignore", "pipe", "ignore"],
		encoding: "utf8",
	});
}

/**
 * Tree state for "did anything change since the verdict?". HEAD plus the
 * full porcelain status (staged, unstaged, and untracked names). Null when
 * git is unavailable or the directory is not a repository: callers fail
 * open (launch normally) instead of risking a wrong suppression.
 */
export function treeFingerprint(
	cwd: string,
	run: GitRunner = defaultGitRunner,
): string | null {
	try {
		const head = run(["rev-parse", "HEAD"], cwd).trim();
		if (!/^[0-9a-f]{40}$/.test(head)) return null;
		const status = run(["status", "--porcelain=v1", "-z"], cwd);
		const digest = createHash("sha256").update(status, "utf8").digest("hex");
		return `git:${head}:${digest}`;
	} catch {
		return null;
	}
}

export function gateFileFor(parentSessionFile: string): string {
	return `${parentSessionFile}${GATE_FILE_SUFFIX}`;
}

export function readGateStore(path: string): ReviewGateStore {
	const empty: ReviewGateStore = { version: STORE_VERSION, gates: {} };
	try {
		const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
		if (!isRecord(raw)) return empty;
		if (raw.version !== STORE_VERSION || !isRecord(raw.gates)) {
			return empty;
		}
		const gates: Record<string, ReviewGate> = {};
		for (const [key, value] of Object.entries(raw.gates)) {
			if (isReviewGate(value)) gates[key] = value;
		}
		return { version: STORE_VERSION, gates };
	} catch {
		// Missing or corrupt sidecars fail open to an empty store.
	}
	return empty;
}

/** Shape guard so half-corrupt sidecars fail open entry by entry. */
function isReviewGate(value: any): value is ReviewGate {
	if (!isRecord(value)) return false;
	return (
		isString(value.key) &&
		isString(value.name) &&
		isString(value.taskSha) &&
		isString(value.cwd) &&
		isString(value.tree) &&
		isString(value.completedAt) &&
		isString(value.summary) &&
		isString(value.childSessionFile) &&
		(value.agent === undefined || isString(value.agent)) &&
		(value.verdict === undefined || isString(value.verdict)) &&
		(value.model === undefined || isString(value.model))
	);
}

export function findGate(
	store: ReviewGateStore,
	key: string,
	cwd: string,
	tree: string,
): ReviewGate | undefined {
	const gate = store.gates[key];
	if (!gate) return undefined;
	if (gate.cwd !== cwd || gate.tree !== tree) return undefined;
	return gate;
}

function writeGateStore(path: string, store: ReviewGateStore): void {
	writeFileSync(path, JSON.stringify(store, null, 2));
}

/** First verdict line when the summary follows the APPROVE/REJECT contract. */
export function verdictOf(summary: string): string | undefined {
	const first = summary
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.length > 0)[0];
	if (first && /^(APPROVE|REJECT)\b/.test(first)) return first;
	return undefined;
}

/** Child session files name their parent session file in the header. */
export function parentSessionFileFor(
	childSessionFile: string,
): string | undefined {
	try {
		const line = readFileSync(childSessionFile, "utf8").split("\n")[0] ?? "";
		const header: unknown = JSON.parse(line);
		if (!isRecord(header)) return undefined;
		return isString(header.parentSession) ? header.parentSession : undefined;
	} catch {
		return undefined;
	}
}

/** Launch scripts start with `cd '<child cwd>' && ...`. */
export function childCwdFromScript(scriptPath: string): string | undefined {
	try {
		const first = readFileSync(scriptPath, "utf8").split("\n")[0] ?? "";
		const match = first.match(/^cd '((?:[^']|'\\'')*)'/);
		if (!match) return undefined;
		return match[1].replace(/'\\''/g, "'");
	} catch {
		return undefined;
	}
}

export interface CompletedGateInput {
	childSessionFile: string;
	launchScriptFile?: string;
	agent?: string;
	name: string;
	task: string;
	summary: string;
	model?: string;
	fingerprint?: (cwd: string) => string | null;
}

/**
 * Record a completed ordinary run as a gate. Never throws and never blocks:
 * any unreadable input skips recording (fail open) and returns undefined.
 */
export function recordCompletedGate(
	input: CompletedGateInput,
): ReviewGate | undefined {
	try {
		const parent = parentSessionFileFor(input.childSessionFile);
		if (!parent) return undefined;
		const cwd = input.launchScriptFile
			? childCwdFromScript(input.launchScriptFile)
			: undefined;
		if (!cwd) return undefined;
		const fingerprint = input.fingerprint ?? treeFingerprint;
		const tree = fingerprint(cwd);
		if (!tree) return undefined;
		const gate: ReviewGate = {
			key: gateKey({
				agent: input.agent,
				name: input.name,
				task: input.task,
			}),
			agent: input.agent,
			name: input.name,
			taskSha: taskSha(input.task),
			cwd,
			tree,
			completedAt: new Date().toISOString(),
			verdict: verdictOf(input.summary),
			summary: input.summary.slice(0, SUMMARY_CAP),
			childSessionFile: input.childSessionFile,
			model: input.model,
		};
		const path = gateFileFor(parent);
		const store = readGateStore(path);
		store.gates[gate.key] = gate;
		writeGateStore(path, store);
		return gate;
	} catch {
		return undefined;
	}
}

export interface DuplicateGateRequest {
	parentSessionFile: string;
	agent?: string;
	name: string;
	task: string;
	cwd: string;
	force?: boolean;
	persistent?: boolean;
	worktree?: boolean;
	fingerprint?: (cwd: string) => string | null;
}

export interface DuplicateGateVerdict {
	suppressed: boolean;
	text?: string;
	details?: {
		status: "duplicate-suppressed";
		name: string;
		task: string;
		agent?: string;
		sessionFile: string;
		completedAt: string;
	};
}

/**
 * Decide whether an identical ordinary request already completed with the
 * same tree state. Anything undecidable fails open (launch normally).
 */
export function checkDuplicateGate(
	req: DuplicateGateRequest,
): DuplicateGateVerdict {
	if (req.force || req.persistent || req.worktree) {
		return { suppressed: false };
	}
	if (!req.parentSessionFile || !req.name || !req.task || !req.cwd) {
		return { suppressed: false };
	}
	const key = gateKey({
		agent: req.agent,
		name: req.name,
		task: req.task,
	});
	const fingerprint = req.fingerprint ?? treeFingerprint;
	const tree = fingerprint(req.cwd);
	if (!tree) return { suppressed: false };
	const gate = findGate(
		readGateStore(gateFileFor(req.parentSessionFile)),
		key,
		req.cwd,
		tree,
	);
	if (!gate) return { suppressed: false };
	const head =
		`Duplicate suppressed: identical${req.agent ? ` ${req.agent}` : ""} request ` +
		`"${req.name}" already completed with no tree changes — no new child launched.`;
	const text =
		`${head}\n\nCached verdict (completed ${gate.completedAt}):\n` +
		`${gate.summary}\n\nOriginal session: ${gate.childSessionFile}\n` +
		`Resume: pi --session ${gate.childSessionFile}\n\n` +
		`To force a fresh run, relaunch with force: true or change the task.`;
	return {
		suppressed: true,
		text,
		details: {
			status: "duplicate-suppressed",
			name: req.name,
			task: req.task,
			agent: req.agent,
			sessionFile: gate.childSessionFile,
			completedAt: gate.completedAt,
		},
	};
}
