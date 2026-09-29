import { afterAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { LockLostError, type LockTiming, withStateLock } from "../src/state-lock.ts";

const roots: string[] = [];
afterAll(async () => {
	await Promise.all(roots.map(dir => rm(dir, { recursive: true, force: true })));
});

async function tempDir(): Promise<string> {
	const dir = await mkdtemp(path.join(tmpdir(), "om-orche-lock-"));
	roots.push(dir);
	return dir;
}

/** Quick polling, and a stale limit no live holder in these tests comes near. */
const TIMING: LockTiming = { staleMs: 5_000, waitMs: 5_000, pollMs: 1 };
const LONG_AGO = new Date(Date.now() - 60_000);

/** One turn of the event loop, so that other contenders' file operations get in while a holder is in its section. */
function turn(): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	setImmediate(resolve);
	return promise;
}

/** The token of the one process holding the lock at `lock`. */
async function tokenOf(lock: string): Promise<string> {
	const tokens = await readdir(lock);
	expect(tokens).toHaveLength(1);
	return path.join(lock, tokens[0] as string);
}

/** Read the counter under the lock, stay in the section across a turn of the event loop, publish counter + 1; `inside` tracks who is in the section. */
async function increment(lockPath: string, counter: string, inside: { now: number; max: number }): Promise<void> {
	await withStateLock(
		lockPath,
		async lock => {
			inside.max = Math.max(inside.max, ++inside.now);
			const current = Number(await readFile(counter, "utf8").catch(() => "0"));
			await turn();
			inside.now--;
			await lock.commit(counter, String(current + 1));
		},
		TIMING,
	);
}

/** Run `lock-worker.ts` in `processes` processes at once, each adding 1 to one counter file `each` times. */
async function countInProcesses(dir: string, processes: number, each: number, staleMs: number): Promise<void> {
	const script = path.join(import.meta.dir, "lock-worker.ts");
	const children = Array.from({ length: processes }, () =>
		Bun.spawn([process.execPath, "run", script, dir, String(each), String(staleMs)], { stdout: "pipe", stderr: "pipe" }),
	);
	const outcomes = await Promise.all(
		children.map(async child => ({ err: await new Response(child.stderr).text(), code: await child.exited })),
	);
	for (const outcome of outcomes) expect(outcome).toEqual({ code: 0, err: "" });
}

describe("mutual exclusion", () => {
	// What this stands for: two processes both judge one dead holder's lock stale, one breaks it and takes the
	// lock, and the other, acting on what it saw before, must not break the new holder's lock as well.
	const leftBehind: Record<string, (lock: string) => Promise<void>> = {
		"a lock directory": async lock => {
			await mkdir(lock);
			await writeFile(path.join(lock, "dead-holder"), "");
			await utimes(path.join(lock, "dead-holder"), LONG_AGO, LONG_AGO);
		},
		"a lock file of an older plugin version": async lock => {
			await writeFile(lock, "dead-process");
			await utimes(lock, LONG_AGO, LONG_AGO);
		},
	};

	for (const [what, leave] of Object.entries(leftBehind)) {
		test(`contenders that all find ${what} of a dead process never overlap and lose no update`, async () => {
			const writers = 8;
			for (let round = 0; round < 25; round++) {
				const dir = await tempDir();
				const lock = path.join(dir, "telemetry.lock");
				const counter = path.join(dir, "counter");
				await leave(lock);
				const inside = { now: 0, max: 0 };

				await Promise.all(Array.from({ length: writers }, () => increment(lock, counter, inside)));

				expect(inside.max).toBe(1);
				expect(await readFile(counter, "utf8")).toBe(String(writers));
				expect(await readdir(dir)).toEqual(["counter"]);
			}
		});
	}

	test("processes that share nothing but the directory lose no update", async () => {
		const dir = await tempDir();

		await countInProcesses(dir, 6, 20, 5_000);

		expect(await readFile(path.join(dir, "counter"), "utf8")).toBe(String(6 * 20));
		expect(await readdir(dir)).toEqual(["counter"]);
	});

	test("processes whose locks keep being broken under them still lose no update", async () => {
		// A stale limit this short makes every holder that is slow, or merely descheduled, look dead: it stands for
		// a process that stops for longer than the limit while it holds the lock. Nothing may be lost, however often that happens.
		const dir = await tempDir();

		await countInProcesses(dir, 4, 8, 6);

		expect(await readFile(path.join(dir, "counter"), "utf8")).toBe(String(4 * 8));
		expect(await readdir(dir)).toEqual(["counter"]);
	});
});

describe("a holder that lost its lock", () => {
	test("publishes nothing over the result of the holder that broke its lock", async () => {
		const dir = await tempDir();
		const lock = path.join(dir, "telemetry.lock");
		const target = path.join(dir, "state");
		const started = Promise.withResolvers<void>();
		const resume = Promise.withResolvers<void>();
		const stalled = withStateLock(
			lock,
			async held => {
				started.resolve();
				await resume.promise;
				return held.commit(target, "stalled").then(
					() => "published",
					(error: unknown) => error,
				);
			},
			TIMING,
		);
		await started.promise;
		// It stops for longer than the stale limit: the next writer judges it dead, breaks its lock and takes over.
		await utimes(await tokenOf(lock), LONG_AGO, LONG_AGO);
		await withStateLock(lock, held => held.commit(target, "successor"), TIMING);

		resume.resolve();

		expect(await stalled).toBeInstanceOf(LockLostError);
		expect(await readFile(target, "utf8")).toBe("successor");
		expect(await readdir(dir)).toEqual(["state"]);
	});

	test("does not give up its successor's lock when it lets go", async () => {
		const dir = await tempDir();
		const lock = path.join(dir, "telemetry.lock");
		const target = path.join(dir, "state");
		const started = Promise.withResolvers<void>();
		const resume = Promise.withResolvers<void>();
		const successorHolds = Promise.withResolvers<void>();
		const successorDone = Promise.withResolvers<void>();
		const stalled = withStateLock(
			lock,
			async () => {
				started.resolve();
				await resume.promise;
			},
			TIMING,
		);
		await started.promise;
		await utimes(await tokenOf(lock), LONG_AGO, LONG_AGO);
		const successor = withStateLock(
			lock,
			async held => {
				successorHolds.resolve();
				await successorDone.promise;
				await held.commit(target, "successor");
			},
			TIMING,
		);
		await successorHolds.promise;

		resume.resolve();
		await stalled;

		// The stalled holder is gone; the successor still holds the lock and finishes its write.
		expect(await readdir(lock)).toHaveLength(1);
		successorDone.resolve();
		await successor;
		expect(await readFile(target, "utf8")).toBe("successor");
	});
});

describe("taking and giving up the lock", () => {
	test("committing publishes the result and leaves no lock, no temporary file", async () => {
		const dir = await tempDir();

		await withStateLock(path.join(dir, "telemetry.lock"), held => held.commit(path.join(dir, "state"), "result"), TIMING);

		expect(await readFile(path.join(dir, "state"), "utf8")).toBe("result");
		expect(await readdir(dir)).toEqual(["state"]);
	});

	test("a section that ends without committing, or that fails, leaves nothing behind", async () => {
		const dir = await tempDir();
		const lock = path.join(dir, "telemetry.lock");

		await withStateLock(lock, async () => {}, TIMING);
		await expect(
			withStateLock(
				lock,
				async () => {
					throw new Error("section failed");
				},
				TIMING,
			),
		).rejects.toThrow("section failed");

		expect(await readdir(dir)).toEqual([]);
	});

	// The next two cases are about waiting, which only elapsed time can tell from not trying: real time is the point.
	test("a contender waits for a live holder and takes over when it is done", async () => {
		const dir = await tempDir();
		const lock = path.join(dir, "telemetry.lock");
		const held = Promise.withResolvers<void>();
		const done = Promise.withResolvers<void>();
		const first = withStateLock(
			lock,
			async () => {
				held.resolve();
				await done.promise;
			},
			TIMING,
		);
		await held.promise;
		let entered = false;
		const second = withStateLock(
			lock,
			async () => {
				entered = true;
			},
			TIMING,
		);

		await Bun.sleep(50);
		expect(entered).toBe(false);
		done.resolve();
		await Promise.all([first, second]);

		expect(entered).toBe(true);
		expect(await readdir(dir)).toEqual([]);
	});

	test("a contender that cannot get the lock in time gives up and leaves the holder alone", async () => {
		const dir = await tempDir();
		const lock = path.join(dir, "telemetry.lock");
		const held = Promise.withResolvers<void>();
		const done = Promise.withResolvers<void>();
		const holder = withStateLock(
			lock,
			async holding => {
				held.resolve();
				await done.promise;
				await holding.commit(path.join(dir, "state"), "holder");
			},
			TIMING,
		);
		await held.promise;

		await expect(withStateLock(lock, async () => {}, { ...TIMING, waitMs: 40 })).rejects.toThrow("is held by another process");

		done.resolve();
		await holder;
		expect(await readFile(path.join(dir, "state"), "utf8")).toBe("holder");
		expect(await readdir(dir)).toEqual(["state"]);
	});

	test("a lock file of an older plugin version is waited for while fresh and broken once stale", async () => {
		const dir = await tempDir();
		const lock = path.join(dir, "telemetry.lock");
		await writeFile(lock, "other-process");

		await expect(withStateLock(lock, async () => {}, { ...TIMING, waitMs: 40 })).rejects.toThrow("is held by another process");
		expect(await readFile(lock, "utf8")).toBe("other-process");

		await utimes(lock, LONG_AGO, LONG_AGO);
		await withStateLock(lock, held => held.commit(path.join(dir, "state"), "result"), TIMING);
		expect(await readdir(dir)).toEqual(["state"]);
	});

	test("a state directory that does not exist is reported and not created", async () => {
		const dir = await tempDir();

		await expect(withStateLock(path.join(dir, "missing", "telemetry.lock"), async () => {}, TIMING)).rejects.toMatchObject({
			code: "ENOENT",
		});

		expect(await readdir(dir)).toEqual([]);
	});
});
