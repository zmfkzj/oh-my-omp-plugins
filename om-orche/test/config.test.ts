import { describe, expect, test } from "bun:test";
import {
	CONFIG_KEYS,
	DEFAULT_CONFIG,
	normalizeConfig,
	parseConfigValue,
	RETIRED_CONFIG_KEYS,
	retiredConfigKeys,
} from "../src/config.ts";

describe("configuration normalization", () => {
	test("CLI-shaped string values from `omp plugin config` are coerced", () => {
		const config = normalizeConfig({ enabled: "false", telemetryEnabled: "false", debugLogging: "true" });
		expect(config).toEqual({ enabled: false, telemetryEnabled: false, debugLogging: true });
	});

	test("garbage values fall back to defaults rather than breaking the policy", () => {
		const config = normalizeConfig({ enabled: 7, debugLogging: "nonsense" });
		expect(config.enabled).toBe(DEFAULT_CONFIG.enabled);
		expect(config.debugLogging).toBe(DEFAULT_CONFIG.debugLogging);
	});

	test("stored retired keys never reach the config and are reported for cleanup", () => {
		const jevRaw = {
			jevModel: "jev-latest",
			orchestrationRoutingEnabled: false,
			orchestrationMinConfidence: 0.99,
			orchestrationMinMargin: 0.9,
			routingTimeoutMs: 250,
			maxRoutingInputChars: 200,
		};
		const tierRaw = { taskRoutingEnabled: false, challengeTaskRole: "slow", taskMinConfidence: 0.9 };
		const raw = { ...jevRaw, ...tierRaw, enabled: false };

		const config = normalizeConfig(raw);
		expect(config).toEqual(normalizeConfig({ enabled: false }));
		expect(Object.keys(config).sort()).toEqual([...CONFIG_KEYS].sort());

		expect(retiredConfigKeys(raw).sort()).toEqual(Object.keys({ ...jevRaw, ...tierRaw }).sort());
		expect(retiredConfigKeys({ enabled: true, telemetryEnabled: false, debugLogging: true })).toEqual([]);
		expect(retiredConfigKeys(undefined)).toEqual([]);
	});

	test("kept and retired keys are disjoint", () => {
		for (const key of CONFIG_KEYS) expect(RETIRED_CONFIG_KEYS as readonly string[]).not.toContain(key);
	});

	test("typed parsing accepts only booleans for the kept keys", () => {
		for (const key of CONFIG_KEYS) {
			expect(parseConfigValue(key, "true")).toBe(true);
			expect(parseConfigValue(key, "false")).toBe(false);
			expect(parseConfigValue(key, "yes")).toBeUndefined();
			expect(parseConfigValue(key, "0.85")).toBeUndefined();
		}
	});
});
