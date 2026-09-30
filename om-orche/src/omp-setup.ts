/**
 * One-time OMP setup.
 *
 * OMP has no plugin install hook, so the earliest supported point is the first
 * main-session `session_start` after install or link. There the plugin fills the
 * OMP settings its features need, once per installation:
 *
 *   - `modelRoles.verification-auditor: "@smol"` the auditor's model role;
 *   - `modelRoles.orche-advisor: "@slow"`        the plan advisor's model role;
 *   - `task.maxRecursionDepth: 1`                (since v2) the main session delegates, workers cannot.
 *
 * The setup is fill-only and never overrides a user value; concrete model IDs
 * are never written. Each item is resolved by where its effective value comes from:
 *
 *   - unset in every layer      → written to the global layer;
 *   - global or project config  → a user value, kept;
 *   - anything session-scoped (CLI flag, `--config` overlay, protocol default)
 *                               → left pending so a later start retries.
 *
 * Every item carries the setup version that introduced it. A run applies only the
 * items newer than the stored marker, so an install upgraded from an older version
 * receives just the new items and never has an earlier item re-filled.
 *
 * A marker in om-orche's plugin settings makes the setup one-time. It is written
 * only after every item is resolved and the written values are flushed to disk,
 * so a failed start retries. The marker is an undeclared internal key: it is not
 * part of `OrcheConfig`. `omp plugin uninstall` and `omp plugin config delete
 * om-orche hostSetupVersion` remove it; `/om-orche reset` keeps it, because a
 * re-run would re-fill keys the user deliberately deleted.
 */
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { PluginManager } from "@oh-my-pi/pi-coding-agent/extensibility/plugins/manager";
import { cfgTaskMaxRecursionDepth } from "@oh-my-pi/pi-coding-agent/task/settings";
import { HOST_SETUP_KEY, PLUGIN_NAME } from "./config.ts";
import { mainSessionOf } from "./host.ts";
import { DEFAULT_LOCK_TIMING, LockLostError, type LockTiming, withStateLock } from "./state-lock.ts";
import { AUDITOR_ROLE } from "./verification-auditor.ts";
import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import type { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { RouteLogger } from "./logging.ts";

/** Setup version this build applies; a stored marker at or above it ends the setup for good. */
export const HOST_SETUP_VERSION = 2;

/** Where the one-time marker lives. */
export interface HostSetupStore {
	/** The stored marker, or `undefined` when absent or not a number. */
	version(): Promise<number | undefined>;
	markApplied(version: number): Promise<void>;
}

/** The marker in the plugin settings map of OMP's plugin manager (`omp-plugins.lock.json`). */
export function pluginSetupStore(): HostSetupStore {
	return {
		async version() {
			const stored = (await new PluginManager().getPluginSettings(PLUGIN_NAME))[HOST_SETUP_KEY];
			return typeof stored === "number" && Number.isFinite(stored) ? stored : undefined;
		},
		async markApplied(version) {
			await new PluginManager().setPluginSetting(PLUGIN_NAME, HOST_SETUP_KEY, version);
		},
	};
}

interface SetupItem {
	key: string;
	value: string;
	/** Setup version that introduced the item; a stored marker at or above it skips the item. */
	since: number;
	/** Layer that supplies the effective value (`Settings.getProvenance` vocabulary). */
	provenance(settings: Settings): string;
	write(settings: Settings): void;
}

function roleItem(role: string, value: string): SetupItem {
	return {
		key: `modelRoles.${role}`,
		value: JSON.stringify(value),
		since: 1,
		provenance: settings => settings.getModelRoleProvenance(role),
		write: settings => settings.setModelRole(role, value),
	};
}

const RECURSION_DEPTH_KEY = "task.maxRecursionDepth";

const SETUP_ITEMS: readonly SetupItem[] = [
	roleItem(AUDITOR_ROLE, "@smol"),
	roleItem("orche-advisor", "@slow"),
	{
		key: RECURSION_DEPTH_KEY,
		value: "1",
		since: 2,
		provenance: settings => settings.getProvenance(cfgTaskMaxRecursionDepth),
		write: settings => cfgTaskMaxRecursionDepth.set(settings, 1),
	},
];

/** User-owned layers: a value here is kept. */
const isUserLayer = (provenance: string): boolean => provenance === "global" || provenance === "project";

export interface HostSetupOptions {
	settings: Settings;
	store: HostSetupStore;
	/** The plugin's state directory; concurrent sessions and processes share its `setup.lock`. */
	stateDir: string;
	/** Bounded acquisition timing, with the same defaults as other state-directory locks. */
	lock?: Partial<LockTiming>;
	logger: Pick<RouteLogger, "info" | "warn" | "describeError">;
	/** Shows the one-time report in the UI; omitted without one. */
	notify?: (message: string) => void;
}

function report(written: readonly SetupItem[]): string {
	const lines = [
		"om-orche configured OMP once, filling only what was unset (existing values were kept):",
		...written.map(item => `  ${item.key}: ${item.value}`),
	];
	const wrote = (key: string) => written.some(item => item.key === key);
	if (written.some(item => item.key.startsWith("modelRoles."))) {
		lines.push("Edit roles in ~/.omp/agent/config.yml.");
	}
	if (wrote(RECURSION_DEPTH_KEY)) {
		lines.push(
			"The main session delegates through `task`; workers run their task directly. Allow deeper delegation with `omp config set task.maxRecursionDepth 2`.",
		);
	}
	return lines.join("\n");
}


/** One attempt per state directory in this process; followers share its result, including a failure. */
const setupRuns = new Map<string, Promise<void>>();

/**
 * Apply the setup once, single-flight in this process and locked across processes.
 * Never throws: a failure is one warning and leaves the marker unwritten, so the
 * next main-session start retries. Partial writes are still reported.
 * Host settings writes cannot be atomically fenced if a holder is paused beyond the lock's stale limit.
 */
export async function applyOmpSetup(options: HostSetupOptions): Promise<void> {
	const lockPath = path.resolve(options.stateDir, "setup.lock");
	const existing = setupRuns.get(lockPath);
	if (existing) return existing;
	const run = applyLockedSetup(options, lockPath);
	setupRuns.set(lockPath, run);
	try {
		await run;
	} finally {
		setupRuns.delete(lockPath);
	}
}

async function applyLockedSetup(
	{ settings, store, stateDir, lock: timing, logger, notify }: HostSetupOptions,
	lockPath: string,
): Promise<void> {
	const written: SetupItem[] = [];
	try {
		await mkdir(stateDir, { recursive: true });
		await withStateLock(lockPath, async lock => {
			// Read only after acquisition: another process may have finished while this one waited.
			const stored = await store.version();
			if (stored !== undefined && stored >= HOST_SETUP_VERSION) return;

			let pending = 0;
			for (const item of SETUP_ITEMS) {
				if (stored !== undefined && item.since <= stored) continue;
				const provenance = item.provenance(settings);
				if (provenance === "default") {
					item.write(settings);
					written.push(item);
				} else if (!isUserLayer(provenance)) {
					pending++;
				}
			}
			if (written.length > 0) await settings.flush();
			if (pending === 0) {
				if (!(await lock.holds())) throw new LockLostError(lockPath);
				await store.markApplied(HOST_SETUP_VERSION);
			}
		}, { ...DEFAULT_LOCK_TIMING, ...timing });
	} catch (error) {
		logger.warn(`OMP setup failed and will be retried at the next session start: ${logger.describeError(error)}`);
	}
	if (written.length === 0) return;
	try {
		logger.info(`OMP setup wrote ${written.map(item => `${item.key}=${item.value}`).join(", ")}`);
		notify?.(report(written));
	} catch (error) {
		logger.warn(`OMP setup report failed: ${logger.describeError(error)}`);
	}
}

/**
 * The setup as `session_start` runs it: main session only, and only while the plugin is enabled.
 * Child sessions inherit settings and must never write global configuration.
 */
export async function runOmpSetup(
	ctx: ExtensionContext,
	options: { enabled: boolean } & Pick<HostSetupOptions, "store" | "stateDir" | "lock" | "logger">,
): Promise<void> {
	const session = mainSessionOf(ctx);
	if (!session || !options.enabled) return;
	await applyOmpSetup({
		settings: session.settings,
		store: options.store,
		stateDir: options.stateDir,
		lock: options.lock,
		logger: options.logger,
		notify: ctx.hasUI ? message => ctx.ui.notify(message, "info") : undefined,
	});
}
