/**
 * One-time OMP setup.
 *
 * OMP has no plugin install hook, so the earliest supported point is the first
 * main-session `session_start` after install or link. There the plugin fills the
 * OMP settings its features need, once per installation:
 *
 *   - `advisor.enabled: true`                    runs the bundled Verification Auditor;
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
import { cfgAdvisorEnabled } from "@oh-my-pi/pi-coding-agent/advisor/settings";
import { PluginManager } from "@oh-my-pi/pi-coding-agent/extensibility/plugins/manager";
import { cfgTaskMaxRecursionDepth } from "@oh-my-pi/pi-coding-agent/task/settings";
import { HOST_SETUP_KEY, PLUGIN_NAME } from "./config.ts";
import { mainSessionOf } from "./host.ts";
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

const ADVISOR_ENABLED_KEY = "advisor.enabled";
const RECURSION_DEPTH_KEY = "task.maxRecursionDepth";

const SETUP_ITEMS: readonly SetupItem[] = [
	{
		key: ADVISOR_ENABLED_KEY,
		value: "true",
		since: 1,
		provenance: settings => settings.getProvenance(cfgAdvisorEnabled),
		write: settings => cfgAdvisorEnabled.set(settings, true),
	},
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

/** The slice of the main session that switches its advisors on and off live. */
export interface LiveAdvisorSession {
	isAdvisorEnabled(): boolean;
	setAdvisorEnabled(enabled: boolean): unknown;
}

export interface HostSetupOptions {
	settings: Settings;
	/** The running main session; its advisor flag is switched on when this run writes `advisor.enabled`. */
	liveAdvisor?: LiveAdvisorSession;
	store: HostSetupStore;
	logger: Pick<RouteLogger, "info" | "warn" | "describeError">;
	/** Shows the one-time report in the UI; omitted without one. */
	notify?: (message: string) => void;
}

function report(written: readonly SetupItem[], settings: Settings): string {
	const lines = [
		"om-orche configured OMP once, filling only what was unset (existing values were kept):",
		...written.map(item => `  ${item.key}: ${item.value}`),
	];
	const wrote = (key: string) => written.some(item => item.key === key);
	const advisorWritten = wrote(ADVISOR_ENABLED_KEY);
	const rolesWritten = written.some(item => item.key.startsWith("modelRoles."));
	const auditorRuns = cfgAdvisorEnabled.get(settings) && (advisorWritten || wrote(`modelRoles.${AUDITOR_ROLE}`));
	if (auditorRuns) lines.push(`The Verification Auditor now reviews each turn with @${AUDITOR_ROLE}.`);
	// `omp config set` reaches registered settings only; model roles are entries of a record setting.
	const setAdvisor = "`omp config set advisor.enabled <true|false>`";
	if (rolesWritten) {
		lines.push(
			advisorWritten
				? `Edit roles in ~/.omp/agent/config.yml; \`advisor.enabled\` can also be changed with ${setAdvisor}.`
				: "Edit roles in ~/.omp/agent/config.yml.",
		);
	} else if (advisorWritten) {
		lines.push(`Change it with ${setAdvisor}.`);
	}
	if (wrote(RECURSION_DEPTH_KEY)) {
		lines.push(
			"The main session delegates through `task`; workers run their task directly. Allow deeper delegation with `omp config set task.maxRecursionDepth 2`.",
		);
	}
	return lines.join("\n");
}

/** Turns the running session's advisors on unless they already are; the flag alone, no runtime is built. */
function enableLiveAdvisor(session: LiveAdvisorSession): void {
	if (typeof session.isAdvisorEnabled !== "function" || typeof session.setAdvisorEnabled !== "function") return;
	if (!session.isAdvisorEnabled()) session.setAdvisorEnabled(true);
}

/**
 * Apply the setup once. Never throws: a failure is one warning and leaves the
 * marker unwritten, so the next main-session start retries. Whatever was written
 * before the failure is still reported, because those values are live in the settings.
 */
export async function applyOmpSetup({ settings, liveAdvisor, store, logger, notify }: HostSetupOptions): Promise<void> {
	const written: SetupItem[] = [];
	try {
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
		// OMP's own `advisor.enabled` listener does not toggle an already-built session (verified
		// on a real host), so do what it would: turn the live flag on, and only for a value this run wrote.
		if (liveAdvisor && written.some(item => item.key === ADVISOR_ENABLED_KEY)) enableLiveAdvisor(liveAdvisor);
		if (pending === 0) await store.markApplied(HOST_SETUP_VERSION);
	} catch (error) {
		logger.warn(`OMP setup failed and will be retried at the next session start: ${logger.describeError(error)}`);
	}
	if (written.length === 0) return;
	try {
		logger.info(`OMP setup wrote ${written.map(item => `${item.key}=${item.value}`).join(", ")}`);
		notify?.(report(written, settings));
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
	options: { enabled: boolean; store: HostSetupStore; logger: HostSetupOptions["logger"] },
): Promise<void> {
	const session = mainSessionOf(ctx);
	if (!session || !options.enabled) return;
	await applyOmpSetup({
		settings: session.settings,
		liveAdvisor: session,
		store: options.store,
		logger: options.logger,
		notify: ctx.hasUI ? message => ctx.ui.notify(message, "info") : undefined,
	});
}
