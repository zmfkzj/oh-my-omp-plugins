/**
 * One process of `state-lock.test.ts`'s multi-process cases: adds 1 to the counter file `<count>` times, each time
 * under the state lock. It reads the counter, stays in its section across a turn of the event loop so that the
 * other processes collide with it, and publishes the sum through the lock, retrying whenever its lock was broken
 * meanwhile. Prints how often that was. Usage: `<state dir> <count> <staleMs>`.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { LockLostError, withStateLock } from "../src/state-lock.ts";

const [dir, count, staleMs] = process.argv.slice(2) as [string, string, string];
const counter = path.join(dir, "counter");
const timing = { staleMs: Number(staleMs), waitMs: 60_000, pollMs: 2 };

function turn(): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	setImmediate(resolve);
	return promise;
}

let broken = 0;
for (let done = 0; done < Number(count); ) {
	try {
		await withStateLock(
			path.join(dir, "telemetry.lock"),
			async lock => {
				const current = Number(await readFile(counter, "utf8").catch(() => "0"));
				await turn();
				await lock.commit(counter, String(current + 1));
			},
			timing,
		);
		done++;
	} catch (error) {
		if (!(error instanceof LockLostError)) throw error;
		broken++;
	}
}
console.log(JSON.stringify({ broken }));
