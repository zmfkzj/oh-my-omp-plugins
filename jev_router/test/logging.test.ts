import { describe, expect, test } from "bun:test";
import { redact, RouteLogger } from "../src/logging.ts";
import { makeApi } from "./harness.ts";

describe("secret redaction", () => {
	test("a tracked credential never reaches an error description", () => {
		const { pi } = makeApi();
		const logger = new RouteLogger(pi.logger);
		logger.trackSecret("ts_live_abcdefghijklmnop");

		const described = logger.describeError(new Error("401 for key ts_live_abcdefghijklmnop on /v1/systemone"));

		expect(described).not.toContain("ts_live_abcdefghijklmnop");
		expect(described).toContain("<redacted>");
	});

	test("key-shaped tokens are scrubbed even when never registered", () => {
		expect(redact("Authorization failed for sk-ABCDEFGHIJKLMNOP", [])).not.toContain("ABCDEFGHIJKLMNOP");
	});

	test("short strings are not treated as secrets", () => {
		expect(redact("status 401 abc", ["abc"])).toBe("status 401 abc");
	});

	test("debug lines are suppressed entirely when debug logging is off", () => {
		const { pi, logs } = makeApi();
		const logger = new RouteLogger(pi.logger);

		logger.route("jev.task", { route: "TASK_CHALLENGE", confidence: 0.8, margin: 0.6 });
		logger.note("something");

		expect(logs).toEqual([]);
	});
});
