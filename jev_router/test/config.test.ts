import { describe, expect, test } from "bun:test";
import { DEFAULT_CONFIG, normalizeConfig, parseConfigValue } from "../src/config.ts";

describe("configuration normalization", () => {
	test("an absent settings record yields the documented defaults", () => {
		expect(normalizeConfig(undefined)).toEqual({
			enabled: true,
			jevModel: "",
			orchestrationRoutingEnabled: true,
			orchestrationMinConfidence: 0.8,
			orchestrationMinMargin: 0.25,
			taskRoutingEnabled: true,
			taskMinConfidence: 0.75,
			taskMinMargin: 0.2,
			normalTaskRole: "task",
			deepTaskRole: "slow",
			routingTimeoutMs: 4000,
			maxRoutingInputChars: 4000,
			telemetryEnabled: true,
			debugLogging: false,
		});
	});

	test("CLI-shaped string values from `omp plugin config` are coerced", () => {
		const config = normalizeConfig({ enabled: "false", taskMinConfidence: "0.9", debugLogging: "true" });
		expect(config.enabled).toBe(false);
		expect(config.taskMinConfidence).toBe(0.9);
		expect(config.debugLogging).toBe(true);
	});

	test("out-of-range thresholds clamp instead of disabling the gate", () => {
		const config = normalizeConfig({ taskMinConfidence: 5, orchestrationMinMargin: -1, routingTimeoutMs: 10 });
		expect(config.taskMinConfidence).toBe(1);
		expect(config.orchestrationMinMargin).toBe(0);
		// A sub-250ms routing budget would time out before any real request.
		expect(config.routingTimeoutMs).toBe(250);
	});

	test("garbage values fall back to defaults rather than breaking routing", () => {
		const config = normalizeConfig({ taskMinConfidence: "nonsense", deepTaskRole: "not a role!", enabled: 7 });
		expect(config.taskMinConfidence).toBe(DEFAULT_CONFIG.taskMinConfidence);
		expect(config.deepTaskRole).toBe("slow");
		expect(config.enabled).toBe(true);
	});

	test("roles accept both `slow` and `@slow` and are stored bare", () => {
		expect(normalizeConfig({ deepTaskRole: "@review" }).deepTaskRole).toBe("review");
		expect(normalizeConfig({ normalTaskRole: "fast_worker" }).normalTaskRole).toBe("fast_worker");
	});

	test("typed parsing rejects a non-boolean for a boolean key", () => {
		expect(parseConfigValue("enabled", "false")).toBe(false);
		expect(parseConfigValue("enabled", "yes")).toBeUndefined();
		expect(parseConfigValue("taskMinConfidence", "0.85")).toBe(0.85);
		expect(parseConfigValue("taskMinConfidence", "high")).toBeUndefined();
		expect(parseConfigValue("deepTaskRole", " review ")).toBe("review");
	});
});
