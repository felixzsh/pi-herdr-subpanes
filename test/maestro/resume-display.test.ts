import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
	findResumedWorkerAgent,
	findResumedWorkerName,
	resolveResumeDisplayName,
} from "../../maestro/runtime/resume-display.ts";

const LOGICAL = "3555eaf2-1b11-4edd-b643-42c001ac960d";
const SESSION = `2026-10-24T00-31-13-420Z_${LOGICAL}-baf28e93-f2bc397b-8e01.jsonl`;

function layout(
	scriptName: string | undefined,
	sessionName: string = SESSION,
	scriptBody = "#!/bin/bash\n",
) {
	const dir = mkdtempSync(join(tmpdir(), "resume-name-"));
	const sessionFile = join(dir, sessionName);
	writeFileSync(sessionFile, "{}\n");
	if (scriptName !== undefined) {
		const scripts = join(dir, "artifacts", "parent-run", "subagent-scripts");
		mkdirSync(scripts, { recursive: true });
		writeFileSync(join(scripts, scriptName), scriptBody);
	}
	return { dir, sessionFile };
}

describe("resume display name", () => {
	it("recovers the original worker name from launch artifacts", () => {
		const { dir, sessionFile } = layout(`realtime-p3-worker-${LOGICAL}.sh`);
		try {
			assert.equal(findResumedWorkerName(sessionFile), "realtime-p3-worker");
			assert.equal(resolveResumeDisplayName(sessionFile), "realtime-p3-worker");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("keeps both names when the explicit label differs", () => {
		const { dir, sessionFile } = layout(`realtime-p3-worker-${LOGICAL}.sh`);
		try {
			assert.equal(
				resolveResumeDisplayName(sessionFile, "Resume-p3-fix"),
				"Resume-p3-fix (realtime-p3-worker)",
			);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("prefers the explicit name alone when it matches or nothing resolves", () => {
		const { dir, sessionFile } = layout(`realtime-p3-worker-${LOGICAL}.sh`);
		const bare = layout(undefined, `2026-10-24T00-31-13-420Z_${LOGICAL}.jsonl`);
		try {
			assert.equal(
				resolveResumeDisplayName(sessionFile, "realtime-p3-worker"),
				"realtime-p3-worker",
			);
			assert.equal(
				resolveResumeDisplayName(bare.sessionFile, "Custom"),
				"Custom",
			);
			assert.equal(resolveResumeDisplayName(bare.sessionFile), "Resume");
		} finally {
			rmSync(dir, { recursive: true, force: true });
			rmSync(bare.dir, { recursive: true, force: true });
		}
	});

	it("ignores resume launch scripts and foreign layouts", () => {
		const { dir, sessionFile } = layout(
			`realtime-p3-worker-resume-1792799108867.sh`,
		);
		try {
			assert.equal(findResumedWorkerName(sessionFile), undefined);
			assert.equal(findResumedWorkerAgent(sessionFile), undefined);
			assert.equal(resolveResumeDisplayName(sessionFile), "Resume");
			assert.equal(
				resolveResumeDisplayName(join(dir, "foreign.jsonl")),
				"Resume",
			);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("recovers the agent role recorded in the launch script", () => {
		const { dir, sessionFile } = layout(
			`realtime-p3-worker-${LOGICAL}.sh`,
			SESSION,
			`#!/bin/bash\nPI_SUBAGENT_AGENT='worker'\n`,
		);
		try {
			assert.equal(findResumedWorkerAgent(sessionFile), "worker");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("ignores missing or empty agent declarations", () => {
		const bare = layout(`realtime-p3-worker-${LOGICAL}.sh`);
		const empty = layout(
			`other-${LOGICAL}.sh`,
			`2026-10-24T00-31-13-420Z_${LOGICAL}-x.jsonl`,
			`#!/bin/bash\nPI_SUBAGENT_AGENT=''\n`,
		);
		try {
			assert.equal(findResumedWorkerAgent(bare.sessionFile), undefined);
			assert.equal(findResumedWorkerAgent(empty.sessionFile), undefined);
		} finally {
			rmSync(bare.dir, { recursive: true, force: true });
			rmSync(empty.dir, { recursive: true, force: true });
		}
	});
});
