#!/usr/bin/env node
/**
 * Verify that every named import in this repository resolves to an export of
 * the module it names.
 *
 * A worker that cannot run the suite in its worktree has no way to discover a
 * renamed or removed export: the failure only appears when the parent runs the
 * gate, one round later. This check is static, needs no dependencies installed
 * in the worktree, and reports the file and line of each unresolved name.
 *
 *   node tools/check-imports.mjs [paths...]
 *
 * Paths default to the source and test trees. Non-relative specifiers are left
 * alone: a package export is Node's business, not this check's.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";

const DEFAULT_ROOTS = ["maestro", "pi-extension", "test", "tools"];
const SOURCE_EXTENSIONS = [".ts", ".tsx", ".mts", ".mjs", ".js"];

function walk(entry, files) {
	let stat;
	try {
		stat = statSync(entry);
	} catch {
		console.error(`check-imports: cannot read ${entry}`);
		return;
	}
	if (stat.isDirectory()) {
		for (const name of readdirSync(entry)) {
			if (name === "node_modules" || name.startsWith(".")) continue;
			walk(join(entry, name), files);
		}
		return;
	}
	if (SOURCE_EXTENSIONS.some((extension) => entry.endsWith(extension)))
		files.push(entry);
}

function resolveSpecifier(fromFile, specifier) {
	const base = join(fromFile, "..", specifier).replaceAll("\\", "/");
	const candidates = [
		base,
		`${base}.ts`,
		`${base}.tsx`,
		`${base}.mts`,
		`${base}/index.ts`,
	];
	for (const candidate of candidates) {
		try {
			if (statSync(candidate).isFile()) return candidate;
		} catch {
			// Try the next candidate.
		}
	}
	return undefined;
}

/** Export names declared by one module; `opaque` when it re-exports with `*`. */
function collectExports(file, seen = new Set()) {
	if (seen.has(file)) return { names: new Set(), opaque: false };
	seen.add(file);
	const text = readFileSync(file, "utf8");
	const source = ts.createSourceFile(
		file,
		text,
		ts.ScriptTarget.Latest,
		true,
		file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
	);
	const names = new Set();
	let opaque = false;
	const declare = (node) => {
		if (node.name && ts.isIdentifier(node.name)) names.add(node.name.text);
	};
	for (const statement of source.statements) {
		if (
			ts.isFunctionDeclaration(statement) ||
			ts.isClassDeclaration(statement) ||
			ts.isInterfaceDeclaration(statement) ||
			ts.isTypeAliasDeclaration(statement) ||
			ts.isEnumDeclaration(statement) ||
			ts.isModuleDeclaration(statement)
		) {
			declare(statement);
			continue;
		}
		if (ts.isVariableStatement(statement)) {
			for (const declaration of statement.declarationList.declarations)
				declare(declaration);
			continue;
		}
		if (!ts.isExportDeclaration(statement)) continue;
		if (statement.exportClause && ts.isNamedExports(statement.exportClause)) {
			for (const element of statement.exportClause.elements)
				names.add((element.name ?? element.propertyName).text);
			continue;
		}
		if (!statement.moduleSpecifier) continue;
		// `export * from "./x"` (or `export * as ns`) can satisfy any name.
		const nested = statement.moduleSpecifier.text;
		if (!nested.startsWith(".")) {
			opaque = true;
			continue;
		}
		const target = resolveSpecifier(file, nested);
		if (!target) {
			opaque = true;
			continue;
		}
		const inner = collectExports(target, seen);
		for (const name of inner.names) names.add(name);
		if (inner.opaque) opaque = true;
	}
	// `export default` makes the module non-empty for default imports.
	if (/\bexport\s+default\b/.test(text)) names.add("default");
	return { names, opaque };
}

function checkFile(file, violations) {
	const text = readFileSync(file, "utf8");
	const source = ts.createSourceFile(
		file,
		text,
		ts.ScriptTarget.Latest,
		true,
		file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
	);
	const report = (node, message) => {
		const { line } = source.getLineAndCharacterOfPosition(node.getStart());
		violations.push(`${file}:${line + 1}: ${message}`);
	};
	for (const statement of source.statements) {
		if (!ts.isImportDeclaration(statement)) continue;
		if (!statement.importClause) continue;
		const specifier = statement.moduleSpecifier.text;
		if (!specifier.startsWith(".")) continue;
		const bindings = statement.importClause.namedBindings;
		if (!bindings || !ts.isNamedImports(bindings)) continue;
		const target = resolveSpecifier(file, specifier);
		if (!target) {
			report(statement, `cannot resolve "${specifier}"`);
			continue;
		}
		const exported = collectExports(target);
		if (exported.opaque) continue;
		for (const element of bindings.elements) {
			const imported = (element.propertyName ?? element.name).text;
			if (imported === "type") continue;
			if (!exported.names.has(imported))
				report(
					element,
					`"${imported}" is not exported by "${specifier}"`,
				);
		}
	}
}

const roots = process.argv.slice(2);
const targets = roots.length > 0 ? roots : DEFAULT_ROOTS;
const files = [];
for (const target of targets) walk(target, files);
const violations = [];
for (const file of files) checkFile(file, violations);

if (violations.length > 0) {
	for (const violation of violations) console.error(violation);
	console.error(
		`check-imports: ${violations.length} unresolved import${violations.length === 1 ? "" : "s"} in ${files.length} files`,
	);
	process.exitCode = 1;
} else {
	console.log(`check-imports: ${files.length} files OK`);
}
