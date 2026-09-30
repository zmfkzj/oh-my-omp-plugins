import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { cfgAdvisorEnabled } from "@oh-my-pi/pi-coding-agent/advisor/settings";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { cfgTaskMaxRecursionDepth } from "@oh-my-pi/pi-coding-agent/task/settings";
import { RouteLogger } from "../src/logging.ts";
import {
	applyOmpSetup,
	type HostSetupOptions,
	type HostSetupStore,
	runOmpSetup,
} from "../src/omp-setup.ts";
import { withStateLock } from "../src/state-lock.ts";
import { clearRegistry, makeApi, makeSession, registerAsMain } from "./harness.ts";
import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";

const tempRoots: string[] = [];
afterEach(() => {
	clearRegistry();
	for (const root of tempRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function stateDir(): string {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "om-orche-setup-state-"));
	tempRoots.push(root);
	return path.join(root, "state");
}

const AUDITOR = "verification-auditor";
const ADVISOR = "orche-advisor";

/** An in-memory marker store; `events` records the order of marker writes against flushes. */
function memoryStore(initial?: number, events: string[] = []) {
	let version = initial;
	const written: number[] = [];
	const store: HostSetupStore & { failWrite?: Error; failRead?: Error } = {
		async version() {
			if (store.failRead) throw store.failRead;
			return version;
		},
		async markApplied(next) {
			if (store.failWrite) throw store.failWrite;
			events.push("marker");
			version = next;
			written.push(next);
		},
	};
	return { store, written };
}

/** Settings with a counted, event-recording `flush`. */
function watched(settings: Settings, events: string[] = []) {
	let flushes = 0;
	const flush = settings.flush.bind(settings);
	settings.flush = async () => {
		flushes++;
		events.push("flush");
		await flush();
	};
	return { settings, flushes: () => flushes };
}

function harness(initial?: number, overrides: Record<string, unknown> = {}) {
	const events: string[] = [];
	const { store, written } = memoryStore(initial, events);
	const watch = watched(Settings.isolated(overrides), events);
	const { pi, logs } = makeApi();
	const notes: string[] = [];
	const options: HostSetupOptions = {
		settings: watch.settings,
		store,
		stateDir: stateDir(),
		logger: new RouteLogger(pi.logger),
		notify: message => void notes.push(message),
	};
	return { ...watch, store, written, logs, notes, events, options, run: () => applyOmpSetup(options) };
}

const warnings = (logs: string[]) => logs.filter(line => line.startsWith("warn "));
const infos = (logs: string[]) => logs.filter(line => line.startsWith("info "));

describe("fresh install", () => {
	test("fills the three unset items in the global layer, flushes, then marks, and reports once", async () => {
		const h = harness();
		await h.run();

		const { settings } = h;
		expect(settings.getProvenance(cfgAdvisorEnabled)).toBe("default");
		expect(cfgAdvisorEnabled.get(settings)).toBe(false);
		expect(settings.getModelRole(AUDITOR)).toBe("@smol");
		expect(settings.getModelRoleProvenance(AUDITOR)).toBe("global");
		expect(settings.getModelRole(ADVISOR)).toBe("@slow");
		expect(settings.getModelRoleProvenance(ADVISOR)).toBe("global");
		expect(settings.getProvenance(cfgTaskMaxRecursionDepth)).toBe("global");
		expect(cfgTaskMaxRecursionDepth.get(settings)).toBe(1);
		expect(h.events).toEqual(["flush", "marker"]);
		expect(h.written).toEqual([2]);
		expect(h.notes).toHaveLength(1);
		expect(infos(h.logs)).toHaveLength(1);
		expect(warnings(h.logs)).toEqual([]);
	});

	test("a second start does nothing, even after the user removed the values", async () => {
		const h = harness();
		await h.run();
		h.settings.setModelRole(ADVISOR, undefined);
		cfgAdvisorEnabled.unset(h.settings);
		cfgTaskMaxRecursionDepth.unset(h.settings);
		await h.run();

		expect(h.settings.getModelRole(ADVISOR)).toBeUndefined();
		expect(cfgAdvisorEnabled.get(h.settings)).toBe(false);
		expect(cfgTaskMaxRecursionDepth.get(h.settings)).toBe(2);
		expect(h.notes).toHaveLength(1);
		expect(h.written).toEqual([2]);
	});

	test("concurrent starts share one setup attempt and report once", async () => {
		const h = harness();
		const second = watched(Settings.isolated());
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const version = h.store.version.bind(h.store);
		h.store.version = async () => {
			// Snapshot before yielding: without serialization, both calls see an absent marker.
			const snapshot = await version();
			entered.resolve();
			await release.promise;
			return snapshot;
		};
		const firstRun = h.run();
		await entered.promise;
		const secondRun = applyOmpSetup({ ...h.options, settings: second.settings });
		release.resolve();
		await Promise.all([firstRun, secondRun]);

		expect(cfgAdvisorEnabled.get(h.settings)).toBe(false);
		expect(h.settings.getModelRole(AUDITOR)).toBe("@smol");
		expect(h.settings.getModelRole(ADVISOR)).toBe("@slow");
		expect(cfgTaskMaxRecursionDepth.get(h.settings)).toBe(1);
		expect(cfgAdvisorEnabled.get(second.settings)).toBe(false);
		expect(second.settings.getModelRole(AUDITOR)).toBeUndefined();
		expect(second.settings.getModelRole(ADVISOR)).toBeUndefined();
		expect(cfgTaskMaxRecursionDepth.get(second.settings)).toBe(2);
		expect(h.flushes()).toBe(1);
		expect(second.flushes()).toBe(0);
		expect(h.written).toEqual([2]);
		expect(h.notes).toHaveLength(1);
		expect(warnings(h.logs)).toEqual([]);
	});
});

describe("user values", () => {
	test("global values are kept untouched, the marker is written and nothing is reported", async () => {
		const h = harness();
		cfgAdvisorEnabled.set(h.settings, false);
		cfgTaskMaxRecursionDepth.set(h.settings, 3);
		h.settings.setModelRole(ADVISOR, "custom/plan");
		h.settings.setModelRole(AUDITOR, "custom/audit");
		await h.run();

		expect(cfgAdvisorEnabled.get(h.settings)).toBe(false);
		expect(cfgTaskMaxRecursionDepth.get(h.settings)).toBe(3);
		expect(h.settings.getModelRole(ADVISOR)).toBe("custom/plan");
		expect(h.settings.getModelRole(AUDITOR)).toBe("custom/audit");
		expect(h.written).toEqual([2]);
		expect(h.notes).toEqual([]);
		expect(infos(h.logs)).toEqual([]);
	});

	test("project-layer values are kept, only unset items are filled", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "om-orche-setup-"));
		try {
			const cwd = path.join(root, "project");
			fs.mkdirSync(path.join(cwd, ".omp"), { recursive: true });
			fs.writeFileSync(path.join(cwd, ".omp", "config.yml"), `modelRoles:\n  ${ADVISOR}: project/plan\n`);
			fs.writeFileSync(path.join(cwd, ".omp", "settings.json"), JSON.stringify({ advisor: { enabled: false } }));
			const settings = await Settings.loadIsolated({ cwd, agentDir: path.join(root, "agent") });
			expect(settings.getProvenance(cfgAdvisorEnabled)).toBe("project");
			expect(settings.getModelRoleProvenance(ADVISOR)).toBe("project");

			const h = harness();
			h.options.settings = settings;
			await applyOmpSetup(h.options);

			expect(cfgAdvisorEnabled.get(settings)).toBe(false);
			expect(settings.getProvenance(cfgAdvisorEnabled)).toBe("project");
			expect(settings.getModelRole(ADVISOR)).toBe("project/plan");
			expect(settings.getModelRoleProvenance(ADVISOR)).toBe("project");
			expect(settings.getModelRole(AUDITOR)).toBe("@smol");
			expect(settings.getModelRoleProvenance(AUDITOR)).toBe("global");
			expect(h.written).toEqual([2]);
			expect(h.notes).toHaveLength(1);
			expect(h.notes[0]).toContain(`modelRoles.${AUDITOR}`);
			expect(h.notes[0]).not.toContain(`modelRoles.${ADVISOR}`);
			expect(h.notes[0]).not.toContain("advisor.enabled");
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});
});

describe("session-scoped values", () => {

	test("a runtime model-role override is never replaced", async () => {
		const h = harness();
		h.settings.overrideModelRoles({ [ADVISOR]: "flag/plan" });
		expect(h.settings.getModelRoleProvenance(ADVISOR)).toBe("runtime");
		await h.run();

		expect(h.settings.getModelRole(ADVISOR)).toBe("flag/plan");
		expect(h.settings.getModelRoleProvenance(ADVISOR)).toBe("runtime");
		expect(h.settings.getModelRole(AUDITOR)).toBe("@smol");
		expect(h.written).toEqual([]);
	});
});

describe("the marker", () => {
	test("a stored marker of 2 prevents every write, even with all keys missing", async () => {
		const h = harness(2);
		await h.run();

		expect(cfgAdvisorEnabled.get(h.settings)).toBe(false);
		expect(h.settings.getModelRole(AUDITOR)).toBeUndefined();
		expect(h.settings.getModelRole(ADVISOR)).toBeUndefined();
		expect(cfgTaskMaxRecursionDepth.get(h.settings)).toBe(2);
		expect(h.flushes()).toBe(0);
		expect(h.written).toEqual([]);
		expect(h.notes).toEqual([]);
	});

	test("a marker below the current version runs the setup", async () => {
		const h = harness(0);
		await h.run();
		expect(h.settings.getModelRole(ADVISOR)).toBe("@slow");
		expect(cfgTaskMaxRecursionDepth.get(h.settings)).toBe(1);
		expect(h.written).toEqual([2]);
	});

	test("a competing lock holder's marker is read after acquisition, so the loser writes nothing", async () => {
		const h = harness();
		fs.mkdirSync(h.options.stateDir, { recursive: true });
		await withStateLock(path.join(h.options.stateDir, "setup.lock"), async () => {
			const attempt = h.run();
			await h.store.markApplied(2);
			return { attempt };
		}).then(async ({ attempt }) => await attempt);

		expect(h.written).toEqual([2]);
		expect(cfgAdvisorEnabled.get(h.settings)).toBe(false);
		expect(h.settings.getModelRole(AUDITOR)).toBeUndefined();
		expect(h.settings.getModelRole(ADVISOR)).toBeUndefined();
		expect(cfgTaskMaxRecursionDepth.get(h.settings)).toBe(2);
		expect(h.flushes()).toBe(0);
		expect(h.notes).toEqual([]);
		expect(warnings(h.logs)).toEqual([]);
	});
});

describe("upgrading from v1", () => {
	test("a v1 marker fills only the recursion depth and never refills the earlier items", async () => {
		const h = harness(1);
		await h.run();

		expect(cfgTaskMaxRecursionDepth.get(h.settings)).toBe(1);
		expect(h.settings.getProvenance(cfgTaskMaxRecursionDepth)).toBe("global");
		expect(cfgAdvisorEnabled.get(h.settings)).toBe(false);
		expect(h.settings.getModelRole(AUDITOR)).toBeUndefined();
		expect(h.settings.getModelRole(ADVISOR)).toBeUndefined();
		expect(h.events).toEqual(["flush", "marker"]);
		expect(h.written).toEqual([2]);
		expect(h.notes).toHaveLength(1);
		expect(h.notes[0]).toContain("task.maxRecursionDepth: 1");
		expect(h.notes[0]).not.toContain("advisor.enabled: ");
		expect(h.notes[0]).not.toContain("modelRoles");
		expect(h.notes[0]).not.toContain("Verification Auditor");
		expect(infos(h.logs)[0]).toContain("task.maxRecursionDepth=1");
		expect(infos(h.logs)[0]).not.toContain("modelRoles");
	});

	test("a user value for the recursion depth is kept and the marker still advances", async () => {
		const h = harness(1);
		cfgTaskMaxRecursionDepth.set(h.settings, 2);
		await h.run();

		expect(cfgTaskMaxRecursionDepth.get(h.settings)).toBe(2);
		expect(h.flushes()).toBe(0);
		expect(h.written).toEqual([2]);
		expect(h.notes).toEqual([]);
	});

	test("a session-scoped recursion depth stays pending without a marker, then a later start fills it", async () => {
		const h = harness(1, { "task.maxRecursionDepth": 5 });
		expect(h.settings.getProvenance(cfgTaskMaxRecursionDepth)).toBe("runtime");
		await h.run();

		expect(cfgTaskMaxRecursionDepth.get(h.settings)).toBe(5);
		expect(h.written).toEqual([]);
		expect(h.notes).toEqual([]);

		cfgTaskMaxRecursionDepth.clearOverride(h.settings);
		await h.run();
		expect(cfgTaskMaxRecursionDepth.get(h.settings)).toBe(1);
		expect(h.written).toEqual([2]);
	});

	test("an RPC/ACP protocol pin of the default leaves the recursion depth pending, and a later start fills it", async () => {
		const h = harness(1);
		cfgTaskMaxRecursionDepth.pinDefault(h.settings);
		expect(h.settings.getProvenance(cfgTaskMaxRecursionDepth)).toBe("runtime");
		await h.run();

		expect(cfgTaskMaxRecursionDepth.get(h.settings)).toBe(2);
		expect(h.written).toEqual([]);
		expect(h.notes).toEqual([]);

		const later = harness(1);
		await later.run();
		expect(cfgTaskMaxRecursionDepth.get(later.settings)).toBe(1);
		expect(later.written).toEqual([2]);
	});
});

describe("failures never reach the session", () => {
	const boom = new Error("disk full");

	test("an unavailable lock warns once without writing, and a later start retries", async () => {
		const h = harness();
		h.options.lock = { waitMs: 0 };
		fs.mkdirSync(h.options.stateDir, { recursive: true });
		await withStateLock(path.join(h.options.stateDir, "setup.lock"), async () => {
			await h.run();
			expect(warnings(h.logs)).toHaveLength(1);
			expect(warnings(h.logs)[0]).toContain("held by another process");
			expect(h.written).toEqual([]);
			expect(h.flushes()).toBe(0);
			expect(cfgAdvisorEnabled.get(h.settings)).toBe(false);
			expect(h.settings.getModelRole(ADVISOR)).toBeUndefined();
			expect(h.notes).toEqual([]);
		});
		await h.run();
		expect(h.written).toEqual([2]);
		expect(h.settings.getModelRole(ADVISOR)).toBe("@slow");
		expect(h.notes).toHaveLength(1);
		expect(warnings(h.logs)).toHaveLength(1);
	});

	test("a failing setting write warns once and leaves no marker, and the next start retries", async () => {
		const h = harness();
		const setModelRole = h.settings.setModelRole.bind(h.settings);
		let failing = true;
		h.settings.setModelRole = (role, value) => {
			if (failing) throw boom;
			setModelRole(role, value);
		};
		await h.run();
		expect(warnings(h.logs)).toHaveLength(1);
		expect(warnings(h.logs)[0]).toContain("disk full");
		expect(h.written).toEqual([]);

		failing = false;
		await h.run();
		expect(h.settings.getModelRole(AUDITOR)).toBe("@smol");
		expect(h.settings.getModelRole(ADVISOR)).toBe("@slow");
		expect(h.written).toEqual([2]);
	});

	test("a failing flush warns once and writes no marker", async () => {
		const h = harness();
		h.settings.flush = async () => {
			throw boom;
		};
		await h.run();
		expect(warnings(h.logs)).toHaveLength(1);
		expect(h.written).toEqual([]);
	});

	test("a failing marker write warns once and leaves the marker unset", async () => {
		const h = harness();
		h.store.failWrite = boom;
		await h.run();
		expect(warnings(h.logs)).toHaveLength(1);
		expect(h.written).toEqual([]);
	});

	test("an unreadable marker warns once and writes nothing", async () => {
		const h = harness();
		h.store.failRead = boom;
		await h.run();
		expect(warnings(h.logs)).toHaveLength(1);
		expect(h.settings.getModelRole(ADVISOR)).toBeUndefined();
		expect(cfgAdvisorEnabled.get(h.settings)).toBe(false);
		expect(h.notes).toEqual([]);
	});

	test("a failing notification does not throw and does not undo the setup", async () => {
		const h = harness();
		h.options.notify = () => {
			throw boom;
		};
		await h.run();
		expect(h.written).toEqual([2]);
		expect(warnings(h.logs)).toHaveLength(1);
	});
});

describe("gates", () => {
	function contextFor(settings: Settings, hasUI = true) {
		const fake = makeSession();
		Object.assign(fake.session, { settings });
		const notes: { message: string; level: string }[] = [];
		const ctx = {
			...fake.ctx,
			hasUI,
			ui: { notify: (message: string, level: string) => notes.push({ message, level }) },
		} as unknown as ExtensionContext;
		return { fake, ctx, notes };
	}

	test("the main session's setup notifies through the UI at info level", async () => {
		const { store, written } = memoryStore();
		const settings = Settings.isolated();
		const { fake, ctx, notes } = contextFor(settings);
		registerAsMain(fake.session);
		const { pi } = makeApi();
		await runOmpSetup(ctx, { enabled: true, store, stateDir: stateDir(), logger: new RouteLogger(pi.logger) });

		expect(settings.getModelRole(ADVISOR)).toBe("@slow");
		expect(written).toEqual([2]);
		expect(notes.map(note => note.level)).toEqual(["info"]);
	});

	test("without a UI the setup still applies and only logs", async () => {
		const { store, written } = memoryStore();
		const settings = Settings.isolated();
		const { fake, ctx, notes } = contextFor(settings, false);
		registerAsMain(fake.session);
		const { pi, logs } = makeApi();
		await runOmpSetup(ctx, { enabled: true, store, stateDir: stateDir(), logger: new RouteLogger(pi.logger) });

		expect(written).toEqual([2]);
		expect(notes).toEqual([]);
		expect(infos(logs)).toHaveLength(1);
	});

	test("a disabled plugin writes nothing and no marker", async () => {
		const { store, written } = memoryStore();
		const settings = Settings.isolated();
		const { fake, ctx, notes } = contextFor(settings);
		registerAsMain(fake.session);
		const { pi } = makeApi();
		await runOmpSetup(ctx, { enabled: false, store, stateDir: stateDir(), logger: new RouteLogger(pi.logger) });

		expect(settings.getModelRole(ADVISOR)).toBeUndefined();
		expect(cfgAdvisorEnabled.get(settings)).toBe(false);
		expect(written).toEqual([]);
		expect(notes).toEqual([]);
	});

	test("a session that is not the main session writes nothing and no marker", async () => {
		const { store, written } = memoryStore();
		const childSettings = Settings.isolated();
		const child = contextFor(childSettings);
		registerAsMain(makeSession().session);
		const { pi } = makeApi();
		await runOmpSetup(child.ctx, { enabled: true, store, stateDir: stateDir(), logger: new RouteLogger(pi.logger) });

		expect(childSettings.getModelRole(ADVISOR)).toBeUndefined();
		expect(written).toEqual([]);
		expect(child.notes).toEqual([]);
	});
});

