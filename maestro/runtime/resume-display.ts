import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

const RESUME_NAME_FALLBACK = "Resume";

/**
 * Original launch script left beside a session file, if any
 * (`artifacts/<parent>/subagent-scripts/<name>-<logicalId>.sh`).
 * Resume launch scripts end in a timestamp, never in the logical ID, so
 * they can never collide with this match.
 */
function findResumedLaunchScript(
	sessionFile: string,
): { path: string; name: string } | undefined {
	try {
		const base = basename(sessionFile);
		const logical = base.match(
			/_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/,
		);
		if (!logical) return undefined;
		const suffix = `-${logical[1]}.sh`;
		const artifacts = join(dirname(sessionFile), "artifacts");
		let parents: string[];
		try {
			parents = readdirSync(artifacts);
		} catch {
			return undefined;
		}
		for (const parent of parents) {
			const dir = join(artifacts, parent, "subagent-scripts");
			let files: string[];
			try {
				files = readdirSync(dir);
			} catch {
				continue;
			}
			for (const file of files) {
				if (!file.endsWith(suffix) || file.length <= suffix.length) continue;
				const path = join(dir, file);
				if (!existsSync(path)) continue;
				return { path, name: file.slice(0, -suffix.length) };
			}
		}
		return undefined;
	} catch {
		return undefined;
	}
}

/**
 * Original worker name for a session file, recovered from its launch
 * script. See findResumedLaunchScript for the matching rule.
 */
export function findResumedWorkerName(sessionFile: string): string | undefined {
	return findResumedLaunchScript(sessionFile)?.name;
}

/**
 * Agent role recorded in the original launch script
 * (`PI_SUBAGENT_AGENT`). Returns undefined when the script is missing,
 * unreadable, or carries no agent value, so callers fall back to an
 * untagged display.
 */
export function findResumedWorkerAgent(
	sessionFile: string,
): string | undefined {
	try {
		const script = findResumedLaunchScript(sessionFile);
		if (!script) return undefined;
		const agent = readFileSync(script.path, "utf8").match(
			/PI_SUBAGENT_AGENT=['"]([^'"]+)['"]/,
		);
		const value = agent?.[1]?.trim();
		return value ? value : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Display name for a resumed session. An explicit name that differs from
 * the recovered original worker keeps both as `<explicit> (<original>)`
 * so the stable worker identity is never hidden behind a one-off resume
 * label. Falls back to "Resume" when nothing is recoverable.
 */
export function resolveResumeDisplayName(
	sessionFile: string,
	explicitName?: string,
): string {
	const original = findResumedWorkerName(sessionFile);
	if (!explicitName) return original ?? RESUME_NAME_FALLBACK;
	if (original && explicitName !== original)
		return `${explicitName} (${original})`;
	return explicitName;
}
