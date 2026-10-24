import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
	checkDuplicateGate,
	childCwdFromScript,
	findGate,
	gateFileFor,
	gateKey,
	parentSessionFileFor,
	readGateStore,
	recordCompletedGate,
	taskSha,
	treeFingerprint,
	verdictOf,
} from "../../maestro/runtime/review-gates.ts";

const TASK = "Read-only review of fix5 against HEAD 9bf1a67.";
const SUMMARY = "APPROVE\n\nReviewed the scope. No findings.";

function stubGit(head = "a".repeat(40), status = "") {
	return (_args: string[], _cwd: string) => {
		if (_args[0] === "rev-parse") return `${head}\n`;
		return status;
	};
}

describe("review gates", () => {
	it("keys identical requests and separates different tasks", () => {
		const a = gateKey({ agent: "reviewer", name: "r", task: TASK });
		const b = gateKey({ agent: "reviewer", name: "r", task: TASK });
		const c = gateKey({ agent: "reviewer", name: "r", task: `${TASK} more` });
		const d = gateKey({ agent: "other", name: "r", task: TASK });
		assert.equal(a, b);
		assert.notEqual(a, c);
		assert.notEqual(a, d);
		assert.equal(taskSha(TASK).length, 64);
	});

	it("fingerprints trees and fails open without git", () => {
		const fp = treeFingerprint("/tmp", stubGit());
		assert.match(fp ?? "", /^git:a{40}:[0-9a-f]{64}$/);
		assert.equal(treeFingerprint("/tmp", stubGit("not-ahead")), null);
		assert.equal(
			treeFingerprint("/tmp", () => {
				throw new Error("no git");
			}),
			null,
		);
	});

	it("reads verdicts from contracted summaries", () => {
		assert.equal(verdictOf(SUMMARY), "APPROVE");
		assert.equal(verdictOf("REJECT\n\nBecause reasons."), "REJECT");
		assert.equal(verdictOf("Some notes without a verdict."), undefined);
	});

	it("derives child cwd and parent session from launch artifacts", () => {
		const dir = mkdtempSync(join(tmpdir(), "review-gates-"));
		try {
			const script = join(dir, "run.sh");
			writeFileSync(script, "cd '/tmp/a'\\''b' && pi --session x\n");
			assert.equal(childCwdFromScript(script), "/tmp/a'b");
			assert.equal(childCwdFromScript(join(dir, "missing.sh")), undefined);
			const child = join(dir, "child.jsonl");
			writeFileSync(
				child,
				`${JSON.stringify({ id: "c1", parentSession: "/tmp/parent.jsonl" })}\n{}`,
			);
			assert.equal(parentSessionFileFor(child), "/tmp/parent.jsonl");
			const orphan = join(dir, "orphan.jsonl");
			writeFileSync(orphan, `${JSON.stringify({ id: "c2" })}\n`);
			assert.equal(parentSessionFileFor(orphan), undefined);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("suppresses an identical completed request and reopens on tree change", () => {
		const dir = mkdtempSync(join(tmpdir(), "review-gates-"));
		try {
			const parent = join(dir, "parent.jsonl");
			writeFileSync(parent, `${JSON.stringify({ id: "p1" })}\n`);
			const child = join(dir, "child.jsonl");
			writeFileSync(
				child,
				`${JSON.stringify({ id: "c1", parentSession: parent })}\n{}`,
			);
			const scriptDir = join(dir, "scripts");
			mkdirSync(scriptDir, { recursive: true });
			const script = join(scriptDir, "run.sh");
			writeFileSync(script, "cd '/work/tree' && pi --session x\n");
			const cwd = "/work/tree";
			const recorded = recordCompletedGate({
				childSessionFile: child,
				launchScriptFile: script,
				agent: "reviewer",
				name: "fix5",
				task: TASK,
				summary: SUMMARY,
				model: "openai/gpt-6.1-sol",
				fingerprint: () => "git:head:tree",
			});
			assert.ok(recorded);
			assert.equal(
				recorded?.childSessionFile,
				child,
				"records the completing child",
			);
			const store = readGateStore(gateFileFor(parent));
			assert.ok(store.gates[recorded?.key ?? ""]);
			const same = checkDuplicateGate({
				parentSessionFile: parent,
				agent: "reviewer",
				name: "fix5",
				task: TASK,
				cwd,
				fingerprint: () => "git:head:tree",
			});
			assert.equal(same.suppressed, true);
			assert.match(same.text ?? "", /Duplicate suppressed/);
			assert.match(same.text ?? "", /APPROVE/);
			assert.equal(same.details?.status, "duplicate-suppressed");
			const changed = checkDuplicateGate({
				parentSessionFile: parent,
				agent: "reviewer",
				name: "fix5",
				task: TASK,
				cwd,
				fingerprint: () => "git:head:changed",
			});
			assert.equal(changed.suppressed, false);
			const otherTask = checkDuplicateGate({
				parentSessionFile: parent,
				agent: "reviewer",
				name: "fix5",
				task: `${TASK} v2`,
				cwd,
				fingerprint: () => "git:head:tree",
			});
			assert.equal(otherTask.suppressed, false);
			const forced = checkDuplicateGate({
				parentSessionFile: parent,
				agent: "reviewer",
				name: "fix5",
				task: TASK,
				cwd,
				force: true,
				fingerprint: () => "git:head:tree",
			});
			assert.equal(forced.suppressed, false);
			const live = checkDuplicateGate({
				parentSessionFile: parent,
				agent: "reviewer",
				name: "fix5",
				task: TASK,
				cwd,
				persistent: true,
				fingerprint: () => "git:head:tree",
			});
			assert.equal(live.suppressed, false);
			const branched = checkDuplicateGate({
				parentSessionFile: parent,
				agent: "reviewer",
				name: "fix5",
				task: TASK,
				cwd,
				worktree: true,
				fingerprint: () => "git:head:tree",
			});
			assert.equal(branched.suppressed, false);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("tolerates missing and corrupt gate stores", () => {
		const dir = mkdtempSync(join(tmpdir(), "review-gates-"));
		try {
			const missing = readGateStore(join(dir, "nope.json"));
			assert.deepEqual(missing.gates, {});
			const corrupt = join(dir, "corrupt.gates.json");
			writeFileSync(corrupt, "not json{{{");
			assert.deepEqual(readGateStore(corrupt).gates, {});
			assert.equal(findGate(missing, "k", "/c", "t"), undefined);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("skips recording when identity or tree state is unavailable", () => {
		const dir = mkdtempSync(join(tmpdir(), "review-gates-"));
		try {
			const orphan = join(dir, "orphan.jsonl");
			writeFileSync(orphan, `${JSON.stringify({ id: "c9" })}\n`);
			assert.equal(
				recordCompletedGate({
					childSessionFile: orphan,
					agent: "reviewer",
					name: "fix5",
					task: TASK,
					summary: SUMMARY,
				}),
				undefined,
			);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
