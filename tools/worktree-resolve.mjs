#!/usr/bin/env node
/**
 * Resolve bare specifiers for a focused test run inside a Herdr-managed Git
 * worktree.
 *
 * A worktree is a fresh checkout: it has no `node_modules`, and ESM resolves a
 * bare specifier from the importing file's directory, so a focused test file
 * fails with ERR_MODULE_NOT_FOUND before any test runs. Symlinking
 * `node_modules` into the worktree makes the failure disappear and leaves a
 * stray artifact that breaks a clean tree.
 *
 * Register this hook instead:
 *
 *   node --experimental-strip-types \
 *     --import /path/to/pi-herdr-agents/tools/worktree-resolve.mjs \
 *     --test test/maestro/example.test.ts
 *
 * Resolution falls back to the main checkout's `node_modules`, which is found
 * through the shared Git common directory, so it works from any worktree of the
 * same repository. Nothing is written to the worktree.
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

function mainCheckoutNodeModules() {
	let commonDir;
	try {
		commonDir = execFileSync("git", ["rev-parse", "--git-common-dir"], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		}).trim();
	} catch {
		return undefined;
	}
	if (!commonDir) return undefined;
	// In a worktree the common dir is `<main>/.git`; in the main checkout it is
	// `.git`, so the candidate resolves to the same directory either way.
	const root = dirname(join(process.cwd(), commonDir));
	const candidate = join(root, "node_modules");
	return existsSync(candidate) ? candidate : undefined;
}

const fallback = mainCheckoutNodeModules();

export async function resolve(specifier, context, nextResolve) {
	try {
		return await nextResolve(specifier, context);
	} catch (error) {
		if (!fallback) throw error;
		if (
			specifier.startsWith(".") ||
			specifier.startsWith("/") ||
			specifier.startsWith("file:") ||
			specifier.startsWith("node:")
		)
			throw error;
		const require = createRequire(join(fallback, "..", "package.json"));
		let resolved;
		try {
			resolved = require.resolve(specifier);
		} catch {
			throw error;
		}
		return nextResolve(pathToFileURL(resolved).href, context);
	}
}
