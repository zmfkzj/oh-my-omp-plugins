/**
 * Extract per-spawn usage from a `task` tool result.
 *
 * The details payload is read structurally rather than through OMP's
 * `TaskToolDetails` type so a shape change in a future OMP release degrades to
 * "no telemetry sample" instead of a thrown handler. Background spawns report
 * an empty `results` array at call time and fill it when their job settles, so
 * this sees whatever the parent session actually observed.
 */
import type { WorkerUsageSample } from "./telemetry.ts";

export interface HarvestedSpawn {
	agent: string;
	usage: WorkerUsageSample;
	durationMs: number;
}

function numberAt(record: Record<string, unknown>, key: string): number | undefined {
	const value = record[key];
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function harvestTaskUsage(details: unknown): HarvestedSpawn[] {
	if (typeof details !== "object" || details === null) return [];
	const results = (details as { results?: unknown }).results;
	if (!Array.isArray(results)) return [];

	const harvested: HarvestedSpawn[] = [];
	for (const entry of results) {
		if (typeof entry !== "object" || entry === null) continue;
		const record = entry as Record<string, unknown>;
		const agent = typeof record.agent === "string" ? record.agent : undefined;
		if (!agent) continue;
		const rawUsage = record.usage;
		const usage: WorkerUsageSample = {};
		if (typeof rawUsage === "object" && rawUsage !== null) {
			const usageRecord = rawUsage as Record<string, unknown>;
			usage.input = numberAt(usageRecord, "input");
			usage.output = numberAt(usageRecord, "output");
			usage.cacheRead = numberAt(usageRecord, "cacheRead");
			usage.cacheWrite = numberAt(usageRecord, "cacheWrite");
			const cost = usageRecord.cost;
			if (typeof cost === "object" && cost !== null) {
				usage.costUsd = numberAt(cost as Record<string, unknown>, "total");
			}
		}
		harvested.push({ agent, usage, durationMs: numberAt(record, "durationMs") ?? 0 });
	}
	return harvested;
}
