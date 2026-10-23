import assert from "node:assert/strict";
import { describe, it } from "node:test";
import fs from "node:fs";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dirname, "../..");
const maestroRoot = path.join(repoRoot, "maestro");
const placementFile = path.join(maestroRoot, "surfaces/herdr/placement.ts");

describe("surface placement gate", () => {
	it("only placement.ts builds or emits tab create and pane split", () => {
		const violations: string[] = [];
		const files = fs
			.readdirSync(maestroRoot, { recursive: true, encoding: "utf8" })
			.filter((entry) => entry.endsWith(".ts"));
		for (const entry of files) {
			const file = path.join(maestroRoot, entry);
			if (file === placementFile) continue;
			const source = fs.readFileSync(file, "utf8");
			const flat = source.replace(/\s+/g, " ");
			const relative = path.relative(repoRoot, file).split(path.sep).join("/");
			for (const builder of ["buildTabCreateArgs", "buildPaneSplitArgs"]) {
				if (source.includes(builder)) {
					violations.push(`${relative}: references ${builder}`);
				}
			}
			if (flat.includes('["tab", "create"')) {
				violations.push(`${relative}: emits tab create`);
			}
			if (flat.includes('["pane", "split"')) {
				violations.push(`${relative}: emits pane split`);
			}
		}
		assert.deepEqual(violations, []);
	});
});
