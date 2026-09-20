/**
 * TypeSafe credential bootstrap.
 *
 * Priority (spec order):
 *   1. `TYPESAFE_API_KEY` in the environment — used directly, never persisted.
 *   2. OMP's own credential store for the `typesafe` provider — the same store
 *      `/login typesafe` writes (`AuthStorage`, SQLite-backed under the OMP
 *      agent dir, owned and permissioned by OMP).
 *   3. Interactive setup, validated against `GET /v1/models` before it is saved.
 *
 * The plugin never writes a key into the repository, the project directory, the
 * plugin source tree, or any log. It owns no credential file of its own: reusing
 * `AuthStorage` means `/login typesafe`, `omp auth`, credential rotation and
 * 401 handling all keep working, and uninstalling the plugin leaves the account
 * credential exactly where the user put it.
 */
import { TypeSafeClient } from "@typesafe-ai/sdk";
import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";

/** Provider id in OMP's auth registry (`pi-catalog/src/compat/rules/auth/typesafe.kdl`). */
export const TYPESAFE_PROVIDER = "typesafe";
export const TYPESAFE_ENV_VAR = "TYPESAFE_API_KEY";

export type CredentialSource = "env" | "omp-credential-store" | "none";

export interface ResolvedCredential {
	key: string;
	source: Exclude<CredentialSource, "none">;
}

/** Where a usable key came from, or `none`. */
export async function resolveCredential(ctx: ExtensionContext): Promise<ResolvedCredential | undefined> {
	const fromEnv = process.env[TYPESAFE_ENV_VAR]?.trim();
	if (fromEnv) return { key: fromEnv, source: "env" };

	const storage = ctx.modelRegistry.authStorage;
	const stored = await storage.getApiKey(TYPESAFE_PROVIDER, ctx.sessionManager.getSessionId());
	if (stored?.trim()) return { key: stored.trim(), source: "omp-credential-store" };
	return undefined;
}

/** Whether a key is persisted in OMP's store (as opposed to supplied by the environment). */
export function hasStoredCredential(ctx: ExtensionContext): boolean {
	return ctx.modelRegistry.authStorage.hasNonEnvCredential(TYPESAFE_PROVIDER);
}

export interface ValidationResult {
	ok: boolean;
	/** Credential-free description of the failure. */
	error?: string;
	/** Model ids the account may use, when validation succeeded. */
	models?: string[];
}

/**
 * Probe `GET /v1/models` with `key`. This is the same endpoint OMP's own
 * `/login typesafe` uses to validate an api-key paste, so an accepted key here
 * is an accepted key there.
 */
export async function validateCredential(key: string, timeoutMs: number): Promise<ValidationResult> {
	let client: TypeSafeClient;
	try {
		client = new TypeSafeClient({ apiKey: key, timeout: timeoutMs, retry: { maxRetries: 0 }, logLevel: "off" });
	} catch (error) {
		return { ok: false, error: error instanceof Error ? error.message : "client construction failed" };
	}
	try {
		const models = await client.models.list({ signal: AbortSignal.timeout(timeoutMs) });
		return { ok: true, models: models.map(model => model.name) };
	} catch (error) {
		const status = (error as { status?: number }).status;
		if (status === 401 || status === 403) return { ok: false, error: `rejected by TypeSafe (HTTP ${status})` };
		if (status !== undefined) return { ok: false, error: `TypeSafe returned HTTP ${status}` };
		return { ok: false, error: error instanceof Error ? error.name : "network failure" };
	}
}

/** Persist a validated key into OMP's credential store. Invalid keys are never stored. */
export async function storeCredential(ctx: ExtensionContext, key: string): Promise<void> {
	await ctx.modelRegistry.authStorage.set(TYPESAFE_PROVIDER, { type: "api_key", key, source: "login" });
}

/** Remove the plugin-provisioned credential. Environment keys are untouched. */
export async function clearStoredCredential(ctx: ExtensionContext): Promise<void> {
	await ctx.modelRegistry.authStorage.remove(TYPESAFE_PROVIDER);
}
