#!/usr/bin/env node
/**
 * Resolve bare specifiers for a focused test run inside a Herdr-managed Git
 * worktree.
 *
 * A worktree is a fresh checkout: it has no `node_modules`, and ESM resolves a
 * bare specifier from the importing file's directory, so a focused test file
 * fails with ERR_MODULE_NOT_FOUND before any test runs. Symlinking
 * `node_modules` into the worktree makes the failure disappear and leaves a
 * stray artifact that breaks the clean tree.
 *
 * Register this hook instead:
 *
 *   node --experimental-strip-types \
 *     --import /path/to/pi-herdr-bg/tools/worktree-resolve.mjs \
 *     --test test/maestro/example.test.ts
 *
 * A specifier that does not resolve from the worktree is retried with the main
 * checkout as its parent URL, so Node applies that checkout's `node_modules`
 * and package `exports` normally. The main checkout is found through the shared
 * Git common directory, and nothing is written to the worktree.
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { registerHooks } from "node:module";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

function mainCheckoutRoot() {
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
	// `.git`, so this root resolves to the same directory either way.
	const root = dirname(resolve(process.cwd(), commonDir));
	return existsSync(join(root, "node_modules")) ? root : undefined;
}

const mainRoot = mainCheckoutRoot();
// Any file inside the main checkout works as a parent; resolution only walks up
// from it to find `node_modules`.
const mainParentUrl = mainRoot
	? pathToFileURL(join(mainRoot, "package.json")).href
	: undefined;

function isBareSpecifier(specifier) {
	return (
		!specifier.startsWith(".") &&
		!specifier.startsWith("/") &&
		!specifier.startsWith("file:") &&
		!specifier.startsWith("node:") &&
		!specifier.startsWith("data:")
	);
}

/**
 * `registerHooks` requires a synchronous resolver: it validates the returned
 * object, so returning a promise fails with ERR_INVALID_RETURN_PROPERTY_VALUE.
 */
function resolveFromMainCheckout(specifier, context, nextResolve) {
	try {
		return nextResolve(specifier, context);
	} catch (error) {
		if (!mainParentUrl || !isBareSpecifier(specifier)) throw error;
		return nextResolve(specifier, { ...context, parentURL: mainParentUrl });
	}
}

// `--import` runs this module but does not install hooks by itself, so register
// the resolver here. Without this the hook is dead code.
if (mainParentUrl) registerHooks({ resolve: resolveFromMainCheckout });
