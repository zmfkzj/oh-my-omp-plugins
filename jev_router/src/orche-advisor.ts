// Bundled checkpoint reviewer and independent Verification Auditor for Jev Router.
// A review is requested explicitly by DEFAULT; the auditor runs in OMP's passive
// WATCHDOG roster when enabled. The two use distinct configurable model roles.

import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import {
  discoverAdvisorConfigs,
  slugifyAdvisorName,
} from "@oh-my-pi/pi-coding-agent/advisor/config";
import type { AdvisorMessageDetails } from "@oh-my-pi/pi-coding-agent/advisor/advise-tool";
import { resolveRoleSelection } from "@oh-my-pi/pi-coding-agent/config/model-resolver";
import { mainSessionOf } from "./host.ts";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { SessionEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { AUDITOR_NAME, VERIFICATION_AUDITOR } from "./verification-auditor.ts";
import {
  CHECKPOINTS,
  ROLE,
  TOOL,
  type VerificationFinding,
  AUDITOR_SLUG,
  prepareReviewInput,
  runReview,
} from "./advisor-review.ts";

const DEFAULT_GUIDANCE = `Orche-Advisor reviews orchestration, not code; it is not a worker or second orchestrator.
You retain planning, delegation, implementation integration, verification, and termination responsibility.
When OMP activates orchestrate, follow the required review checkpoints in its orchestration notice.
Otherwise, call orche_advisor explicitly only when its expected benefit exceeds its cost at a material checkpoint:
important initial plan; before large fan-out; at least two failures on the same problem; major replan;
important phase boundary; expansion across subsystems; or explicit orchestration escalation.
Outside orchestrate, these checkpoints permit review; they do not require it.
Never call just because a worker completed or for routine/local work outside orchestrate.
Do not repeat a review without material new information. Combine overlapping checkpoints.
Send only the seven compact snapshot fields, not conversation history, repository contents, worker logs,
or credentials. Unresolved ${AUDITOR_NAME} findings are attached automatically from the transcript;
never transcribe, summarize, or soften one into a snapshot field yourself.
Describe relevant constraints in Goal. Use 'None' for empty fields.
Supply additional context only when needed; decide whether requested information merits another call.
Weigh the short verdict and changes; retain final decisions. Do not call another reviewer merely because
Orche-Advisor completed. Existing watchdog advisors retain their existing responsibilities.`;

const ORCHESTRATE_GUIDANCE = `<system-notice>
Orche-Advisor integration for this orchestrate request. These checkpoints are REQUIRED, not optional:
1. After scoping and forming the initial plan, call orche_advisor with checkpoint "initial-plan".
   Read its result before dispatching workers or implementing the plan, even if the work stays inline.
2. After verifying a phase, call with checkpoint "phase-boundary" before advancing to the next phase.
   For a changed decomposition, major replan, scope expansion, or repeated failures, review the updated
   snapshot before dispatching or implementing the revised plan, using the corresponding checkpoint.
3. One review covers overlapping checkpoints. Do not repeat an unchanged snapshot, review each worker
   completion, or request another review merely because the reviewer returned. No final-only review.
4. Send only the seven compact snapshot fields. Use actual task state and 'None' for empty fields.
   Wait for the result, weigh it, and continue the task in the same turn; you remain the orchestrator.
   If the tool fails, report the failure rather than claiming review succeeded; do not loop on retries.
</system-notice>`;

const primarySession = mainSessionOf;

/**
 * Add the bundled auditor to the live advisor roster unless the user declares their own.
 *
 * Discovery is re-run rather than mutated blind: `applyAdvisorConfigs` replaces the roster
 * wholesale and the session exposes no getter to read the current one back, so appending to
 * a freshly discovered copy is the only lossless way to add one entry. This mirrors what
 * `/advisor configure` does on save.
 *
 * A `WATCHDOG.yml` entry whose name slugifies the same wins outright — that is the documented
 * way to repoint the model, retune the instructions, or switch the auditor off entirely.
 */
async function installVerificationAuditor(primary: AgentSession): Promise<void> {
  // Never mutate the roster while advisors are disabled: the auditor cannot run, so an apply
  // would only rebuild a roster the user turned off. The auditor is installed on the first
  // session_start that runs with advisors enabled.
  if (!primary.isAdvisorEnabled()) return;

  const discovered = await discoverAdvisorConfigs(
    primary.sessionManager.getCwd(),
    primary.settings.getAgentDir(),
  );
  if (discovered.advisors.some((advisor) => slugifyAdvisorName(advisor.name) === AUDITOR_SLUG))
    return;
  // Applying a non-empty roster is what removes OMP's synthesized default advisor
  // (`session-advisors.ts:855-856`); a user who wants a general advisor declares one in `WATCHDOG.yml`.
  primary.applyAdvisorConfigs(
    [...discovered.advisors, VERIFICATION_AUDITOR],
    discovered.sharedInstructions,
    discovered.sharedMaxNotesPerUpdate,
  );
}

/**
 * Advisor notes that landed after the most recent completed review, oldest first.
 *
 * The window closes at the previous review rather than spanning the session: a note the
 * reviewer already weighed must not be re-raised once DEFAULT has acted on it, and an
 * unbounded window would grow the prompt with findings the snapshot already reflects.
 * An empty window also means "no new evidence since that review", which is what makes
 * the identical-snapshot reuse path below safe to keep.
 */
export function findingsSinceLastReview(branch: readonly SessionEntry[]): VerificationFinding[] {
  const collected: VerificationFinding[] = [];
  for (let index = branch.length - 1; index >= 0; index--) {
    const entry = branch[index];
    if (entry?.type !== "message") continue;
    const message = entry.message;
    if (
      message.role === "toolResult" &&
      message.toolName === TOOL &&
      !message.isError &&
      (message.details as { role?: string } | undefined)?.role === ROLE
    )
      break;
    if (message.role === "custom" && message.customType === "advisor") {
      const notes = (message.details as AdvisorMessageDetails | undefined)?.notes;
      // Unshift the batch whole: notes are already ordered within one advisor message.
      if (Array.isArray(notes)) collected.unshift(...notes);
    }
  }
  return collected;
}

export function registerOrcheAdvisor(pi: ExtensionAPI): void {
  const z = pi.zod;
  const field = z.string().min(1).max(2000);
  let inFlight = false;

  // Only the explicit tool invokes the reviewer model. Lifecycle hooks never request reviews;
  // the auditor installed here is OMP's own passive advisor runtime, billed as an advisor.
  pi.on("session_start", async (_event, ctx) => {
    const primary = primarySession(ctx);
    if (!primary) {
      pi.setActiveTools(pi.getActiveTools().filter((name) => name !== TOOL));
      return;
    }
    await installVerificationAuditor(primary);
  });
  pi.on("before_agent_start", (event, ctx) => {
    if (primarySession(ctx) && pi.getActiveTools().includes(TOOL)) {
      return { systemPrompt: [...event.systemPrompt, DEFAULT_GUIDANCE] };
    }
  });
  pi.on("context", (event, ctx) => {
    if (!primarySession(ctx) || !pi.getActiveTools().includes(TOOL)) return;

    // Use OMP's own notice, not a second keyword parser: this respects prose boundaries,
    // disabled magic keywords, synthetic prompts, and queued user messages.
    let changed = false;
    for (const message of event.messages) {
      if (
        message.role === "custom" &&
        message.customType === "orchestrate-notice" &&
        message.attribution === "user" &&
        typeof message.content === "string" &&
        !message.content.endsWith(ORCHESTRATE_GUIDANCE)
      ) {
        message.content += `\n\n${ORCHESTRATE_GUIDANCE}`;
        changed = true;
      }
    }
    if (changed) return { messages: event.messages };
  });

  pi.registerTool({
    name: TOOL,
    label: "Orche-Advisor",
    description: `Request one orchestration-only checkpoint review using @orche-advisor. DEFAULT only. Required for orchestrate initial plans and phase/replan checkpoints; optional otherwise. Never for routine worker completion. Send a compact snapshot, not conversation or repository contents; unresolved ${AUDITOR_NAME} findings are attached automatically. A repeated snapshot reuses the prior review without a model call unless a new finding has landed.`,
    loadMode: "essential",
    deferrable: false,
    parameters: z
      .object({
        checkpoint: z.enum(CHECKPOINTS),
        snapshot: z
          .object({
            goal: field,
            currentPlan: field,
            completedWork: field,
            agents: field,
            failuresOrBlockers: field,
            tokenOrContextConcerns: field,
            nextProposedActions: field,
          })
          .strict(),
      })
      .strict(),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const primary = primarySession(ctx);
      if (!primary)
        throw new Error(
          "Orche-Advisor is available only to the primary orchestrator, not workers.",
        );
      if (inFlight)
        throw new Error(
          "An orchestration review is already running; use its result before requesting another.",
        );
      // Search only local branch metadata; no transcript is passed to the reviewer.
      const branch = primary.sessionManager.getBranch();
      const prepared = prepareReviewInput(params, findingsSinceLastReview(branch));
      const { snapshotHash, findings } = prepared;
      // Reuse stays keyed on the seven snapshot fields alone, but only while no verification
      // finding has landed since the last review. Hashing findings into the identity instead
      // would make every post-review call miss, since the window resets to empty each time;
      // this way new evidence invalidates a cached KEEP and an idle repeat still costs nothing.
      for (let index = branch.length - 1; findings.length === 0 && index >= 0; index--) {
        const entry = branch[index];
        if (
          entry?.type !== "message" ||
          entry.message.role !== "toolResult" ||
          entry.message.toolName !== TOOL ||
          entry.message.isError
        )
          continue;
        const prior = entry.message.details as
          | { role?: string; snapshotHash?: string; model?: string; reused?: boolean }
          | undefined;
        if (prior?.role === ROLE && prior.snapshotHash === snapshotHash && !prior.reused) {
          return {
            content: [
              {
                type: "text",
                text: "Reusing the previous review of this snapshot; no verification finding has landed since, so no model call was made.",
              },
              ...entry.message.content,
            ],
            details: {
              role: ROLE,
              snapshotHash,
              findingsForwarded: 0,
              model: prior.model,
              reused: true,
              usage: null,
            },
          };
        }
      }

      inFlight = true;
      try {
        await primary.settings.reloadFromDisk();
        const selection = resolveRoleSelection(
          [ROLE],
          primary.settings,
          ctx.modelRegistry.getAvailable(),
        );
        if (!selection)
          throw new Error(
            "Configure modelRoles.orche-advisor with an available model; no DEFAULT/slow fallback is used.",
          );
        // Capture the initiating branch before the call; the leaf may advance while the review runs.
        const usageOwner = {
          sessionId: primary.sessionManager.getSessionId(),
          parentId: primary.sessionManager.getLeafId(),
        };
        const review = await runReview(prepared, selection, ctx.modelRegistry, signal);
        for (const attempt of review.details.attempts) {
          const entryId = primary.sessionManager.appendModelUsage(
            {
              purpose: TOOL,
              role: ROLE,
              api: attempt.api,
              provider: attempt.provider,
              model: attempt.model,
              usage: attempt.usage,
              stopReason: attempt.stopReason,
              ...(attempt.errorMessage ? { errorMessage: attempt.errorMessage } : {}),
            },
            usageOwner,
          );
          if (entryId) usageOwner.parentId = entryId;
        }
        return {
          ...(review.isError ? { isError: true } : {}),
          content: [{ type: "text", text: review.text }],
          details: review.details,
        };
      } finally {
        inFlight = false;
      }
    },
  });
}
