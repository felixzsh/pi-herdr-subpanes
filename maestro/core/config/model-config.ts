import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isPlainObject, isString } from "./type-guards.ts";

export interface ModelConfig {
	default?: string;
	agents: Record<string, string>;
}

function invalidModelConfig(source: string, message: string): never {
	throw new Error(`Invalid subagent model config in ${source}: ${message}`);
}

export function parseModelConfig(
	rawConfig: any,
	source = "config.json",
): ModelConfig {
	if (!isPlainObject(rawConfig))
		invalidModelConfig(source, "root must be an object");
	const models = rawConfig.models;
	if (models == null) return { agents: {} };
	if (!isPlainObject(models))
		invalidModelConfig(source, "models must be an object");
	const allowedKeys = new Set(["default", "agents"]);
	const unsupportedKeys = Object.keys(models).filter(
		(key) => !allowedKeys.has(key),
	);
	if (unsupportedKeys.length > 0)
		invalidModelConfig(
			source,
			`models has unsupported key(s): ${unsupportedKeys.join(", ")}`,
		);

	let defaultModel: string | undefined;
	if (models.default != null) {
		if (!isString(models.default) || models.default.trim() === "")
			invalidModelConfig(source, "models.default must be a non-empty string");
		defaultModel = models.default.trim();
	}
	const agents: Record<string, string> = {};
	if (models.agents != null) {
		if (!isPlainObject(models.agents))
			invalidModelConfig(source, "models.agents must be an object");
		for (const [agent, model] of Object.entries(models.agents)) {
			if (!isString(model) || model.trim() === "")
				invalidModelConfig(
					source,
					`models.agents.${agent} must be a non-empty string`,
				);
			const trimmed = model.trim();
			Object.defineProperty(agents, agent, {
				value: trimmed,
				enumerable: true,
				writable: true,
				configurable: true,
			});
		}
	}
	const config: ModelConfig = { agents };
	if (defaultModel) config.default = defaultModel;
	return config;
}

export function resolveModelDefault(
	agentName: string | undefined,
	agentModel: string | undefined,
	config: ModelConfig,
): string | undefined {
	if (agentModel) return agentModel;
	if (agentName && Object.hasOwn(config.agents, agentName))
		return config.agents[agentName];
	return config.default;
}

export function loadModelConfig(configDir: string): ModelConfig {
	const configPath = join(configDir, "config.json");
	let source: string;
	try {
		source = readFileSync(configPath, "utf8");
	} catch (error) {
		// SAFETY: readFileSync errors expose the Node errno code.
		if ((error as NodeJS.ErrnoException).code === "ENOENT")
			return { agents: {} };
		throw error;
	}
	try {
		return parseModelConfig(JSON.parse(source), configPath);
	} catch (error) {
		if (error instanceof SyntaxError)
			throw new Error(
				`Invalid JSON in subagent model config ${configPath}: ${error.message}`,
			);
		throw error;
	}
}
