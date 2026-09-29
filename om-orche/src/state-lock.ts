/**
 * The exclusive lock on the plugin's state directory.
 *
 * Several OMP processes read-modify-write `telemetry.json`, so a writer holds
 * this lock from its read until its result is published. The lock is the
 * directory `telemetry.lock`: absent or empty means free, and a held lock holds
 * exactly one file, the holder's token (a fresh UUID nobody else ever names).
 *
 * - Acquire: stage a private directory holding a fresh token, then `rename` it
 *   onto the lock path. `rename` replaces only an absent or an empty directory,
 *   so it succeeds for one process at a time, and the lock never exists
 *   without its holder's token in it.
 * - Publish: the holder's result is written into its own token file and
 *   `commit` renames that file over the target. That one step both publishes
 *   the result and takes the token out of the lock, so it can only succeed
 *   while the token is still there. Tokens are never recreated, so a token that
 *   is there was there without a break since the lock was acquired, and no
 *   other holder existed in between: the read, the merge and the publication
 *   were one atomic step. A holder whose token was removed gets `ENOENT`,
 *   publishes nothing and keeps its result for a later attempt.
 * - Break: a token untouched for longer than `staleMs` belongs to a process that
 *   died, and any waiter unlinks it by its exact name. A newer holder has another
 *   name, so a breaker can only remove the very holder it judged; a breaker that
 *   is slow, or one that judged a holder that was merely stopped, costs that
 *   holder its lock and never anyone's data.
 * - Release: unlink the own token by name, then `rmdir`, which removes only an
 *   empty directory.
 *
 * So exclusion and the no-lost-update guarantee do not depend on timing, on
 * clocks or on how long a process is paused; only how soon a dead holder's lock
 * is given up does. Plugin versions before the lock directory kept a lock
 * *file* under the same name: it is waited for while fresh and broken when
 * stale, like a token. Between such old processes the old races remain.
 */
import { randomUUID } from "node:crypto";
import { mkdir, open, readdir, rename, rmdir, stat, unlink } from "node:fs/promises";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

export interface LockTiming {
	/** A holder needs milliseconds; a token this old was left behind by a process that died. */
	staleMs: number;
	/** How long one acquisition waits for another holder. OMP gives a `session_shutdown` handler 2 s in all. */
	waitMs: number;
	pollMs: number;
}

export const DEFAULT_LOCK_TIMING: Readonly<LockTiming> = Object.freeze({ staleMs: 5_000, waitMs: 1_000, pollMs: 20 });

/** What a holder can do with the lock it is given. */
export interface StateLock {
	/**
	 * Publish `data` as `target` by renaming a complete file into place, which also ends the hold. Rejects with
	 * {@link LockLostError}, publishing nothing, when the lock was broken before the holder got here.
	 */
	commit(target: string, data: string): Promise<void>;
	/** Whether the lock is still this holder's, as of now. */
	holds(): Promise<boolean>;
}

/** The holder was judged dead and its lock broken, or taken over, before it finished; nothing was published. */
export class LockLostError extends Error {
	constructor(lockPath: string) {
		super(`${lockPath} was broken by another process while this one held it`);
		this.name = "LockLostError";
	}
}

function errorCode(error: unknown): string | undefined {
	const code = (error as { code?: unknown } | null | undefined)?.code;
	return typeof code === "string" ? code : undefined;
}

/** Why `rename` could not put a staged directory on the lock path: the path is taken, or holds something that is not a lock directory. */
const TAKEN: Record<string, true> = {
	ENOTEMPTY: true,
	EEXIST: true,
	ENOTDIR: true,
	EISDIR: true,
	EPERM: true,
	EACCES: true,
	EBUSY: true,
	// The staged directory itself is gone (a reset cleaned it up): stage another.
	ENOENT: true,
};

const STAGING_SUFFIX = /^\.[0-9a-f-]{36}\.tmp$/;

/** Whether `name` is a directory an acquisition staged next to the lock called `lockName` and never cleaned up. */
export function isLockStaging(lockName: string, name: string): boolean {
	return name.startsWith(`${lockName}.`) && STAGING_SUFFIX.test(name.slice(lockName.length));
}

class Held implements StateLock {
	readonly #lockPath: string;
	readonly #token: string;
	#ended = false;

	constructor(lockPath: string, token: string) {
		this.#lockPath = lockPath;
		this.#token = path.join(lockPath, token);
	}

	async holds(): Promise<boolean> {
		try {
			await stat(this.#token);
			return true;
		} catch {
			return false;
		}
	}

	async commit(target: string, data: string): Promise<void> {
		try {
			const handle = await open(this.#token, "r+");
			try {
				await handle.writeFile(data);
				await handle.sync();
			} finally {
				await handle.close();
			}
			await rename(this.#token, target);
		} catch (error) {
			// A missing token is a lost lock; a missing target directory is not.
			if (errorCode(error) === "ENOENT" && !(await this.holds())) throw new LockLostError(this.#lockPath);
			throw error;
		}
		this.#ended = true;
		await rmdir(this.#lockPath).catch(() => {});
	}

	/** Give the lock up. Never rejects: a token that is already gone was broken by someone else. */
	async release(): Promise<void> {
		if (this.#ended) return;
		this.#ended = true;
		await unlink(this.#token).catch(() => {});
		await rmdir(this.#lockPath).catch(() => {});
	}
}

/** A private directory next to the lock, holding a fresh token: complete before it is ever visible at the lock path. */
async function stage(lockPath: string): Promise<{ dir: string; token: string }> {
	const token = randomUUID();
	const dir = `${lockPath}.${token}.tmp`;
	// Not recursive: a state directory that does not exist stays that way.
	await mkdir(dir);
	try {
		await (await open(path.join(dir, token), "wx")).close();
	} catch (error) {
		await rmdir(dir).catch(() => {});
		throw error;
	}
	return { dir, token };
}

/** Take the lock if it is free; undefined when someone holds it. */
async function tryTake(lockPath: string): Promise<Held | undefined> {
	const { dir, token } = await stage(lockPath);
	try {
		await rename(dir, lockPath);
	} catch (error) {
		await unlink(path.join(dir, token)).catch(() => {});
		await rmdir(dir).catch(() => {});
		if (TAKEN[errorCode(error) ?? ""]) return undefined;
		throw error;
	}
	return new Held(lockPath, token);
}

/** Remove a lock file an older plugin version left, once it is stale; true when it is gone. */
async function breakLockFile(lockPath: string, staleMs: number): Promise<boolean> {
	try {
		if (Date.now() - (await stat(lockPath)).mtimeMs <= staleMs) return false;
		await unlink(lockPath);
		return true;
	} catch (error) {
		return errorCode(error) === "ENOENT";
	}
}

/**
 * Whether the lock can be taken now. A lock whose holder must have died is broken on the way and counts as free.
 * Looking first also keeps a contender from staging a directory on every poll while someone else holds the lock.
 */
async function assess(lockPath: string, staleMs: number): Promise<"free" | "held"> {
	let tokens: string[];
	try {
		tokens = await readdir(lockPath);
	} catch (error) {
		switch (errorCode(error)) {
			case "ENOENT":
				return "free";
			case "ENOTDIR":
				return (await breakLockFile(lockPath, staleMs)) ? "free" : "held";
			default:
				return "held";
		}
	}
	if (tokens.length === 0) {
		// Free. `rename` replaces an empty directory, but a platform that cannot needs it removed first.
		await rmdir(lockPath).catch(() => {});
		return "free";
	}
	let live = false;
	for (const token of tokens) {
		const file = path.join(lockPath, token);
		try {
			if (Date.now() - (await stat(file)).mtimeMs <= staleMs) {
				live = true;
				continue;
			}
			// By exact name: a holder that took over meanwhile has another token, and this one is not its.
			await unlink(file);
		} catch (error) {
			// Released, committed or broken by someone else meanwhile: not a holder any more.
			if (errorCode(error) !== "ENOENT") live = true;
		}
	}
	return live ? "held" : "free";
}

async function acquire(lockPath: string, timing: LockTiming): Promise<Held> {
	const deadline = Date.now() + timing.waitMs;
	for (;;) {
		if ((await assess(lockPath, timing.staleMs)) === "free") {
			const held = await tryTake(lockPath);
			if (held) return held;
		}
		if (Date.now() >= deadline) throw new Error(`${lockPath} is held by another process`);
		await sleep(timing.pollMs);
	}
}

/**
 * Run `work` holding the lock at `lockPath`, whose directory must exist. Rejects when the lock cannot be
 * taken within `timing.waitMs`; the lock is released however `work` ends.
 */
export async function withStateLock<T>(
	lockPath: string,
	work: (lock: StateLock) => Promise<T>,
	timing: LockTiming = DEFAULT_LOCK_TIMING,
): Promise<T> {
	const held = await acquire(lockPath, timing);
	try {
		return await work(held);
	} finally {
		await held.release();
	}
}
