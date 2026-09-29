import { describe, expect, test } from "bun:test";
import { RouteLogger } from "../src/logging.ts";
import { makeApi } from "./harness.ts";

describe("debug logging", () => {
	test("policy lines are suppressed entirely when debug logging is off", () => {
		const { pi, logs } = makeApi();
		const logger = new RouteLogger(pi.logger);

		logger.policy({ mode: "orchestrate" });
		logger.policy({ skip: "plan-mode" });

		expect(logs).toEqual([]);
	});

	test("an enabled logger emits one fixed-shape line per record and can be switched off again", () => {
		const { pi, logs } = makeApi();
		const logger = new RouteLogger(pi.logger);
		logger.setEnabled(true);

		logger.policy({ mode: "workflow" });
		logger.policy({ skip: "disabled" });
		logger.setEnabled(false);
		logger.policy({ mode: "default" });

		expect(logs).toEqual(["debug om-orche.policy mode=workflow", "debug om-orche.policy skip=disabled"]);
	});

	test("an error description is bounded", () => {
		const { pi } = makeApi();
		const described = new RouteLogger(pi.logger).describeError(new Error("x".repeat(1000)));
		expect(described.length).toBe(200);
		expect(described.startsWith("Error: xxx")).toBe(true);
	});
});
