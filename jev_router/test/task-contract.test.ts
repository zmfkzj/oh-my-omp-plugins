import { describe, expect, test } from "bun:test";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { normalizeCall, prepareDispatch } from "../src/task-contract.ts";
import { makeApi } from "./harness.ts";

describe("normalizeCall", () => {
	test("batch and flat shapes both yield their item list and keep the whole call", () => {
		const batch = { context: "Shared background.", isolated: true, tasks: [{ agent: "task", task: "a" }] };
		expect(normalizeCall(batch)).toEqual({ input: batch, items: [{ agent: "task", task: "a" }] });
		const flat = { agent: "task", task: "a" };
		expect(normalizeCall(flat)).toEqual({ input: flat, items: [flat] });
	});

	test("inputs without a complete worker list are not calls", () => {
		for (const input of [{ nonsense: true }, { context: "c", tasks: [] }, { context: "c", tasks: [{ task: "a" }, "b"] }]) {
			expect(normalizeCall(input)).toBeUndefined();
		}
	});
});

describe("prepareDispatch", () => {
	test("an omitted agent resolves to the session's live native default, never an assumed task", () => {
		const { pi, taskSchema } = makeApi();
		const declared = { context: "c", tasks: [{ name: "W", task: "x" }] };
		expect(prepareDispatch(pi, declared).items).toEqual([{ name: "W", agent: "task", task: "x" }]);
		taskSchema.defaultAgent = "sonic";
		expect(prepareDispatch(pi, declared).items).toEqual([{ name: "W", agent: "sonic", task: "x" }]);
		expect(prepareDispatch(pi, { context: "c", tasks: [{ name: "W", agent: "task", task: "x" }] }).items[0]?.agent).toBe("task");
	});

	test("only the top-level intent is dropped; nested fields named i remain part of the contract", () => {
		const { pi } = makeApi();
		const outputSchema = { properties: { i: { type: "string" } } };
		const plain = prepareDispatch(pi, { context: "c", tasks: [{ name: "W", task: "x", outputSchema }] });
		expect(prepareDispatch(pi, { i: "Plan the release", context: "c", tasks: [{ name: "W", task: "x", outputSchema }] })).toEqual(plain);
		expect(plain.items[0]?.outputSchema).toEqual(outputSchema);
	});

	test("the active flat or batch shape decides validity; nothing is guessed around it", () => {
		const { pi, taskSchema } = makeApi();
		expect(() => prepareDispatch(pi, { name: "Flat", task: "x" })).toThrow();
		expect(() => prepareDispatch(pi, { tasks: [{ name: "W", task: "x" }] })).toThrow();
		expect(() => prepareDispatch(pi, { context: "c", tasks: [] })).toThrow();
		taskSchema.batchEnabled = false;
		expect(prepareDispatch(pi, { name: "Flat", task: "x" }).items).toEqual([{ name: "Flat", agent: "task", task: "x" }]);
		expect(() => prepareDispatch(pi, { context: "c", tasks: [{ name: "W", task: "x" }] })).toThrow();
	});

	test("a session without the task tool has no contract", () => {
		const pi = { getAllTools: () => [] } as unknown as ExtensionAPI;
		expect(() => prepareDispatch(pi, { context: "c", tasks: [{ name: "W", task: "x" }] })).toThrow();
	});
});
