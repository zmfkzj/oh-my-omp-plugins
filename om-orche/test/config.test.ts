import { describe, expect, test } from "bun:test";
import { DEFAULT_CONFIG, normalizeConfig, parseConfigValue, retiredConfigKeys } from "../src/config.ts";

describe("configuration normalization", () => {
	test("CLI-shaped string values from `omp plugin config` are coerced", () => {
		const config = normalizeConfig({ enabled: "false", orchestrationMinConfidence: "0.9", debugLogging: "true" });
		expect(config.enabled).toBe(false);
		expect(config.orchestrationMinConfidence).toBe(0.9);
		expect(config.debugLogging).toBe(true);
	});

	test("out-of-range thresholds clamp instead of disabling the gate", () => {
		const config = normalizeConfig({ orchestrationMinConfidence: 5, orchestrationMinMargin: -1, routingTimeoutMs: 10 });
		expect(config.orchestrationMinConfidence).toBe(1);
		expect(config.orchestrationMinMargin).toBe(0);
		// A sub-250ms routing budget would time out before any real request.
		expect(config.routingTimeoutMs).toBe(250);
	});

	test("garbage values fall back to defaults rather than breaking routing", () => {
		const config = normalizeConfig({ orchestrationMinConfidence: "nonsense", enabled: 7 });
		expect(config.orchestrationMinConfidence).toBe(DEFAULT_CONFIG.orchestrationMinConfidence);
		expect(config.enabled).toBe(true);
	});

	test("stored tier-routing keys never reach the config but are reported for cleanup", () => {
		const raw = { taskRoutingEnabled: false, challengeTaskRole: "slow", taskMinConfidence: 0.9, enabled: true };
		const config = normalizeConfig(raw);
		expect(config).toEqual(normalizeConfig({ enabled: true }));
		expect(retiredConfigKeys(raw)).toEqual(["taskRoutingEnabled", "taskMinConfidence", "challengeTaskRole"]);
		expect(retiredConfigKeys({ enabled: true })).toEqual([]);
		expect(retiredConfigKeys(undefined)).toEqual([]);
	});

	test("typed parsing rejects a non-boolean for a boolean key", () => {
		expect(parseConfigValue("enabled", "false")).toBe(false);
		expect(parseConfigValue("enabled", "yes")).toBeUndefined();
		expect(parseConfigValue("orchestrationMinConfidence", "0.85")).toBe(0.85);
		expect(parseConfigValue("orchestrationMinConfidence", "high")).toBeUndefined();
		expect(parseConfigValue("jevModel", " jev-latest ")).toBe("jev-latest");
	});
});
