import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { discoverAgentCatalog } from "../../maestro/core/roles/discovery.ts";
import { loadRoleConfig } from "../../maestro/core/config/role-config.ts";
import {
	loadModelConfig,
	parseModelConfig,
} from "../../maestro/core/config/model-config.ts";
import { loadPaneConfig } from "../../maestro/core/config/pane-config.ts";
import { loadPersistentConfig } from "../../maestro/core/config/persistent-config.ts";
import { loadSupervisionConfig } from "../../maestro/core/config/supervision-config.ts";

test("Task17 core discovery consumes the injected role-pack protocol and preserves order, diagnostics, raw defaults and provenance", () => {
	const root = mkdtempSync(join(tmpdir(), "core-role-discovery-"));
	try {
		const agentDir = join(root, "agent");
		const cwd = join(root, "project");
		const pack = join(root, "pack", "roles");
		for (const dir of [
			join(agentDir, "agents"),
			join(cwd, ".pi", "agents"),
			pack,
		])
			mkdirSync(dir, { recursive: true });
		const role = (dir: string, name: string, fields = "") =>
			writeFileSync(
				join(dir, `${name}.md`),
				`---\nname: ${name}\ndescription: ${dir}\n${fields}\n---\n${name} body`,
			);
		role(pack, "alpha");
		role(
			pack,
			"beta",
			"model: task:invalid-raw-default\ntools: read,bash\nskills: skill-a,skill-b\ndeny-tools: write\nspawning: false\nauto-exit: true\nsession-mode: lineage-only\ncwd: role-folder\nthinking: high",
		);
		role(join(agentDir, "agents"), "alpha");
		role(join(cwd, ".pi", "agents"), "alpha", "disable-model-invocation: true");
		role(join(cwd, ".pi", "agents"), "gamma");
		writeFileSync(
			join(root, "pack", "package.json"),
			JSON.stringify({ name: "role-pack", version: "2.3.4" }),
		);
		let projections = 0;
		const catalog = discoverAgentCatalog({
			agentConfigDir: agentDir,
			cwd,
			onRolePackDiscovered(event) {
				projections++;
				assert.equal(event.apiVersion, 1);
				event.register("relative-path");
				event.register(pack);
				event.register(pack);
			},
		});
		assert.equal(projections, 1);
		assert.deepEqual(
			catalog.agents.map((agent) => agent.name),
			["alpha", "beta", "gamma"],
		);
		assert.deepEqual(
			catalog.diagnostics.map((diagnostic) => diagnostic.code),
			["invalid-role-pack-path"],
		);
		assert.equal(catalog.agents[0].source, "project");
		assert.equal(catalog.agents[0].disableModelInvocation, true);
		const beta = catalog.agents[1];
		assert.equal(beta.provider, "role-pack");
		assert.equal(beta.providerVersion, "2.3.4");
		assert.equal(beta.path, join(pack, "beta.md"));
		assert.equal(
			beta.model,
			"task:invalid-raw-default",
			"discovery must not silently validate/drop the raw model",
		);
		assert.deepEqual(beta.role, {
			name: "beta",
			version: "2.3.4",
			description: pack,
			systemPrompt: "beta body",
			allowedTools: ["read", "bash"],
			source: "package",
			defaults: {
				model: "task:invalid-raw-default",
				thinking: "high",
				sessionMode: "lineage-only",
				spawning: false,
				autoExit: true,
				interactive: undefined,
				persistent: undefined,
				systemPromptMode: undefined,
				denyTools: ["write"],
				skills: ["skill-a", "skill-b"],
				cwd: "role-folder",
			},
		});
		const failed = discoverAgentCatalog({
			agentConfigDir: agentDir,
			cwd,
			onRolePackDiscovered() {
				throw new Error("discovery error");
			},
		});
		assert.equal(failed.diagnostics[0].code, "role-pack-discovery-failed");
		assert.deepEqual(
			failed.agents.map((agent) => agent.name),
			["alpha", "gamma"],
		);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("models.enforceAgentDefaults parses as an opt-in boolean pin", () => {
	assert.deepEqual(parseModelConfig({ models: {} }), { agents: {} });
	assert.equal(
		parseModelConfig({ models: { enforceAgentDefaults: true } })
			.enforceAgentDefaults,
		true,
	);
	assert.equal(
		parseModelConfig({ models: { enforceAgentDefaults: false } })
			.enforceAgentDefaults,
		false,
	);
	assert.throws(
		() => parseModelConfig({ models: { enforceAgentDefaults: "yes" } }),
		(error: Error) =>
			error.message.includes("models.enforceAgentDefaults must be a boolean"),
	);
	const root = mkdtempSync(join(tmpdir(), "core-model-pin-"));
	try {
		const configDir = join(root, "durable-dir");
		mkdirSync(configDir);
		writeFileSync(
			join(configDir, "config.json"),
			JSON.stringify({
				models: { agents: { reviewer: "a/b" }, enforceAgentDefaults: true },
			}),
		);
		assert.deepEqual(loadModelConfig(configDir), {
			agents: { reviewer: "a/b" },
			enforceAgentDefaults: true,
		});
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("Task17 all five config owners use only the explicit config directory and example, failing strictly without fallback on invalid durable data", () => {
	const root = mkdtempSync(join(tmpdir(), "core-config-inputs-"));
	try {
		const configDir = join(root, "explicit-durable-dir");
		mkdirSync(configDir);
		const configPath = join(configDir, "config.json");
		const example = join(root, "explicit-example.json");
		writeFileSync(
			example,
			JSON.stringify({
				models: { default: "ignored/example" },
				roles: { bundled: false },
				panes: { mode: "split" },
				persistent: { maxAgents: 9 },
				supervision: { forcePolling: true },
			}),
		);
		writeFileSync(
			join(root, "config.json"),
			JSON.stringify({ models: { default: "decoy/model" } }),
		);
		assert.deepEqual(loadModelConfig(configDir), { agents: {} });
		assert.equal(loadRoleConfig(configDir, example).deprecations.length, 1);
		assert.equal(loadPaneConfig(configDir, example).mode, "split");
		assert.equal(loadPersistentConfig(configDir, example).maxAgents, 9);
		assert.equal(loadSupervisionConfig(configDir, example).forcePolling, true);
		const fallbackReaders = [
			loadRoleConfig,
			loadPaneConfig,
			loadPersistentConfig,
			loadSupervisionConfig,
		];
		for (const read of fallbackReaders)
			assert.throws(
				() => read(configDir, join(root, "absent-example")),
				(error: Error) =>
					error.message.includes(configPath) &&
					error.message.includes("absent-example"),
			);
		writeFileSync(configPath, "{");
		for (const read of [loadModelConfig, ...fallbackReaders])
			assert.throws(
				() => read(configDir, example),
				(error: Error) =>
					error.message.includes(configPath) &&
					error.message.includes("Invalid JSON"),
			);
		writeFileSync(configPath, "[]");
		for (const read of [loadModelConfig, ...fallbackReaders])
			assert.throws(() => read(configDir, example), /root must be an object/);
		writeFileSync(
			configPath,
			JSON.stringify({
				models: { default: "saved/model" },
				roles: { bundled: true },
			}),
		);
		assert.equal(loadModelConfig(configDir).default, "saved/model");
		const [deprecation] = loadRoleConfig(configDir, example).deprecations;
		assert.ok(deprecation.includes(configPath));
		assert.match(deprecation, /roles\.bundled \(true\)/);
		rmSync(configPath);
		mkdirSync(configPath);
		for (const read of [loadModelConfig, ...fallbackReaders])
			assert.throws(() => read(configDir, example), /EISDIR/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
