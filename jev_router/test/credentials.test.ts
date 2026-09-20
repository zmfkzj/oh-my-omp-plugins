import { afterEach, describe, expect, test } from "bun:test";
import { hasStoredCredential, resolveCredential, storeCredential, TYPESAFE_ENV_VAR } from "../src/credentials.ts";
import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";

interface StorageCalls {
	set: { provider: string; credential: unknown }[];
}

function makeCtx(options: { stored?: string } = {}): { ctx: ExtensionContext; calls: StorageCalls } {
	const calls: StorageCalls = { set: [] };
	let stored = options.stored;
	const ctx = {
		sessionManager: { getSessionId: () => "s1" },
		modelRegistry: {
			authStorage: {
				// Mirrors AuthStorage: env wins inside getApiKey too, so the plugin's own
				// env branch must short-circuit before this is consulted.
				getApiKey: async () => process.env[TYPESAFE_ENV_VAR]?.trim() || stored,
				hasNonEnvCredential: () => stored !== undefined,
				set: async (provider: string, credential: unknown) => {
					calls.set.push({ provider, credential });
					stored = (credential as { key: string }).key;
				},
			},
		},
	} as unknown as ExtensionContext;
	return { ctx, calls };
}

afterEach(() => {
	delete process.env[TYPESAFE_ENV_VAR];
});

describe("credential resolution", () => {
	test("the environment key wins and is reported as not persisted", async () => {
		process.env[TYPESAFE_ENV_VAR] = "  env_key_value  ";
		const { ctx, calls } = makeCtx({ stored: "stored_key_value" });

		expect(await resolveCredential(ctx)).toEqual({ key: "env_key_value", source: "env" });
		// Reading an env key must never write it anywhere.
		expect(calls.set).toEqual([]);
	});

	test("OMP's credential store is used when the environment is unset", async () => {
		const { ctx } = makeCtx({ stored: "stored_key_value" });
		expect(await resolveCredential(ctx)).toEqual({ key: "stored_key_value", source: "omp-credential-store" });
	});

	test("no credential resolves to undefined rather than an empty key", async () => {
		const { ctx } = makeCtx();
		expect(await resolveCredential(ctx)).toBeUndefined();
		expect(hasStoredCredential(ctx)).toBe(false);
	});

	test("storing goes to the shared typesafe provider so /login typesafe stays interchangeable", async () => {
		const { ctx, calls } = makeCtx();
		await storeCredential(ctx, "fresh_key_value");

		expect(calls.set).toEqual([
			{ provider: "typesafe", credential: { type: "api_key", key: "fresh_key_value", source: "login" } },
		]);
		expect(await resolveCredential(ctx)).toEqual({ key: "fresh_key_value", source: "omp-credential-store" });
	});
});
