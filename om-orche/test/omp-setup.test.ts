import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { cfgAdvisorEnabled } from "@oh-my-pi/pi-coding-agent/advisor/settings";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { RouteLogger } from "../src/logging.ts";
import {
	applyOmpSetup,
	type HostSetupOptions,
	type HostSetupStore,
	type LiveAdvisorSession,
	runOmpSetup,
} from "../src/omp-setup.ts";
import { clearRegistry, makeApi, makeSession, registerAsMain } from "./harness.ts";
import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";

afterEach(clearRegistry);

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
		expect(settings.getProvenance(cfgAdvisorEnabled)).toBe("global");
		expect(cfgAdvisorEnabled.get(settings)).toBe(true);
		expect(settings.getModelRole(AUDITOR)).toBe("@smol");
		expect(settings.getModelRoleProvenance(AUDITOR)).toBe("global");
		expect(settings.getModelRole(ADVISOR)).toBe("@slow");
		expect(settings.getModelRoleProvenance(ADVISOR)).toBe("global");
		expect(h.events).toEqual(["flush", "marker"]);
		expect(h.written).toEqual([1]);
		expect(h.notes).toHaveLength(1);
		for (const key of ["advisor.enabled", `modelRoles.${AUDITOR}`, `modelRoles.${ADVISOR}`]) {
			expect(h.notes[0]).toContain(key);
		}
		expect(infos(h.logs)).toHaveLength(1);
		expect(warnings(h.logs)).toEqual([]);
	});

	test("a second start does nothing, even after the user removed the values", async () => {
		const h = harness();
		await h.run();
		h.settings.setModelRole(ADVISOR, undefined);
		cfgAdvisorEnabled.unset(h.settings);
		await h.run();

		expect(h.settings.getModelRole(ADVISOR)).toBeUndefined();
		expect(cfgAdvisorEnabled.get(h.settings)).toBe(false);
		expect(h.notes).toHaveLength(1);
		expect(h.written).toEqual([1]);
	});
});

describe("user values", () => {
	test("global values are kept untouched, the marker is written and nothing is reported", async () => {
		const h = harness();
		cfgAdvisorEnabled.set(h.settings, false);
		h.settings.setModelRole(ADVISOR, "custom/plan");
		h.settings.setModelRole(AUDITOR, "custom/audit");
		await h.run();

		expect(cfgAdvisorEnabled.get(h.settings)).toBe(false);
		expect(h.settings.getModelRole(ADVISOR)).toBe("custom/plan");
		expect(h.settings.getModelRole(AUDITOR)).toBe("custom/audit");
		expect(h.written).toEqual([1]);
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
			expect(h.written).toEqual([1]);
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
	test("a runtime override leaves its item pending with no marker, and a later start finishes it", async () => {
		const h = harness(undefined, { "advisor.enabled": false });
		expect(h.settings.getProvenance(cfgAdvisorEnabled)).toBe("runtime");
		await h.run();

		expect(cfgAdvisorEnabled.get(h.settings)).toBe(false);
		expect(h.settings.getProvenance(cfgAdvisorEnabled)).toBe("runtime");
		expect(h.settings.getModelRole(AUDITOR)).toBe("@smol");
		expect(h.settings.getModelRole(ADVISOR)).toBe("@slow");
		expect(h.written).toEqual([]);
		expect(h.notes).toHaveLength(1);
		expect(h.notes[0]).not.toContain("advisor.enabled");

		cfgAdvisorEnabled.clearOverride(h.settings);
		expect(h.settings.getProvenance(cfgAdvisorEnabled)).toBe("default");
		await h.run();

		expect(h.settings.getProvenance(cfgAdvisorEnabled)).toBe("global");
		expect(cfgAdvisorEnabled.get(h.settings)).toBe(true);
		expect(h.written).toEqual([1]);
		expect(h.notes).toHaveLength(2);
		expect(h.notes[1]).toContain("advisor.enabled");
		expect(h.notes[1]).not.toContain("modelRoles");
	});

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
	for (const version of [1, 2]) {
		test(`a stored marker of ${version} prevents every write, even with all keys missing`, async () => {
			const h = harness(version);
			await h.run();

			expect(cfgAdvisorEnabled.get(h.settings)).toBe(false);
			expect(h.settings.getModelRole(AUDITOR)).toBeUndefined();
			expect(h.settings.getModelRole(ADVISOR)).toBeUndefined();
			expect(h.flushes()).toBe(0);
			expect(h.written).toEqual([]);
			expect(h.notes).toEqual([]);
		});
	}

	test("a marker below the current version runs the setup", async () => {
		const h = harness(0);
		await h.run();
		expect(h.settings.getModelRole(ADVISOR)).toBe("@slow");
		expect(h.written).toEqual([1]);
	});
});

describe("failures never reach the session", () => {
	const boom = new Error("disk full");

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
		expect(h.written).toEqual([1]);
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
		expect(h.written).toEqual([1]);
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
		await runOmpSetup(ctx, { enabled: true, store, logger: new RouteLogger(pi.logger) });

		expect(settings.getModelRole(ADVISOR)).toBe("@slow");
		expect(written).toEqual([1]);
		expect(notes.map(note => note.level)).toEqual(["info"]);
	});

	test("without a UI the setup still applies and only logs", async () => {
		const { store, written } = memoryStore();
		const settings = Settings.isolated();
		const { fake, ctx, notes } = contextFor(settings, false);
		registerAsMain(fake.session);
		const { pi, logs } = makeApi();
		await runOmpSetup(ctx, { enabled: true, store, logger: new RouteLogger(pi.logger) });

		expect(written).toEqual([1]);
		expect(notes).toEqual([]);
		expect(infos(logs)).toHaveLength(1);
	});

	test("a disabled plugin writes nothing and no marker", async () => {
		const { store, written } = memoryStore();
		const settings = Settings.isolated();
		const { fake, ctx, notes } = contextFor(settings);
		registerAsMain(fake.session);
		const { pi } = makeApi();
		await runOmpSetup(ctx, { enabled: false, store, logger: new RouteLogger(pi.logger) });

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
		await runOmpSetup(child.ctx, { enabled: true, store, logger: new RouteLogger(pi.logger) });

		expect(childSettings.getModelRole(ADVISOR)).toBeUndefined();
		expect(written).toEqual([]);
		expect(child.notes).toEqual([]);
	});
});

describe("live advisor flag", () => {
	function live(enabled = false) {
		const calls: boolean[] = [];
		let current = enabled;
		return {
			calls,
			session: {
				isAdvisorEnabled: () => current,
				setAdvisorEnabled: (next: boolean) => {
					calls.push(next);
					current = next;
					return false;
				},
			},
		};
	}

	test("is switched on once, after the flush, when this run wrote advisor.enabled", async () => {
		const h = harness();
		const advisor = live();
		const setAdvisorEnabled = advisor.session.setAdvisorEnabled;
		advisor.session.setAdvisorEnabled = next => {
			h.events.push("live");
			return setAdvisorEnabled(next);
		};
		h.options.liveAdvisor = advisor.session;
		await h.run();

		expect(advisor.calls).toEqual([true]);
		expect(h.events).toEqual(["flush", "live", "marker"]);
	});

	test("is not touched when the session already has advisors on", async () => {
		const h = harness();
		const advisor = live(true);
		h.options.liveAdvisor = advisor.session;
		await h.run();
		expect(advisor.calls).toEqual([]);
	});

	test("is not touched when advisor.enabled is a user value, whatever it says", async () => {
		for (const userValue of [true, false]) {
			const h = harness();
			const advisor = live();
			cfgAdvisorEnabled.set(h.settings, userValue);
			h.options.liveAdvisor = advisor.session;
			await h.run();
			expect(advisor.calls).toEqual([]);
		}
	});

	test("is not touched while advisor.enabled is pending behind a session-scoped value", async () => {
		const h = harness(undefined, { "advisor.enabled": false });
		const advisor = live();
		h.options.liveAdvisor = advisor.session;
		await h.run();
		expect(advisor.calls).toEqual([]);
	});

	test("a session without the live API is skipped without a warning", async () => {
		const h = harness();
		h.options.liveAdvisor = {} as unknown as LiveAdvisorSession;
		await h.run();
		expect(warnings(h.logs)).toEqual([]);
		expect(h.written).toEqual([1]);
	});

	test("a throwing toggle warns once and leaves no marker", async () => {
		const h = harness();
		h.options.liveAdvisor = {
			isAdvisorEnabled: () => false,
			setAdvisorEnabled: () => {
				throw new Error("no runtime");
			},
		};
		await h.run();
		expect(warnings(h.logs)).toHaveLength(1);
		expect(h.written).toEqual([]);
	});
});

describe("the report's change instructions", () => {
	test("point to `omp config set` for advisor.enabled only, never for model roles", async () => {
		const h = harness();
		await h.run();
		expect(h.notes[0]).toContain("omp config set advisor.enabled");
		expect(h.notes[0]).not.toMatch(/omp config set (?!advisor\.enabled)/);
		expect(h.notes[0]).toContain("~/.omp/agent/config.yml");
	});

	test("omit `omp config set` when advisor.enabled was not written", async () => {
		const h = harness();
		cfgAdvisorEnabled.set(h.settings, false);
		await h.run();
		expect(h.notes[0]).toContain("~/.omp/agent/config.yml");
		expect(h.notes[0]).not.toContain("omp config set");
	});
});
