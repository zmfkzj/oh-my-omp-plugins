// Bundled checkpoint reviewer and independent Verification Auditor for Jev Router.
// A review is requested explicitly by DEFAULT; the auditor runs in OMP's passive
// WATCHDOG roster when enabled. The two use distinct configurable model roles.

import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import {
  discoverAdvisorConfigs,
  slugifyAdvisorName,
} from "@oh-my-pi/pi-coding-agent/advisor/config";
import { resolveRoleSelection } from "@oh-my-pi/pi-coding-agent/config/model-resolver";
import { mainSessionOf } from "./host.ts";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AUDITOR_NAME, VERIFICATION_AUDITOR } from "./verification-auditor.ts";
import {
  CHECKPOINTS,
  ROLE,
  TOOL,
  AUDITOR_SLUG,
  prepareReviewInput,
  runReview,
  type ReviewResult,
} from "./advisor-review.ts";
import { collectFindings, findingRevision } from "./findings.ts";
import { ReviewGate } from "./review-gate.ts";

const DEFAULT_GUIDANCE = `Orche-Advisor reviews orchestration, not code; it is not a worker or second orchestrator.
You retain planning, delegation, implementation integration, verification, and termination responsibility.
Reviews are mandatory when the execution gate or a committed phase/scope notice requires them.
Do not call initial-plan merely because a new user turn, risk assessment, or auditor note arrived.
Before submitting a worker batch, you may predeclare its exact task input via the optional
dispatch field of orche_advisor; then submit that same task input after reading the verdict.
Otherwise the task gate stages the scope without spawning, and asks for a review before retry.
Omit dispatch to retain staged contracts; pass dispatch: null to withdraw them when moving to
parent-only work. Withdrawal requires a fresh review and does not cancel running workers.
Never use tasks: [] or invent a dummy task to clear a dispatch.
Changed plans, dispatch contracts, phase boundaries or finding state invalidate previous receipts.
Do not loop on unchanged failures. Provider/runtime errors are not rejected plans: the tool makes
one bounded provider retry, and later review remains available after recovery without a waiver.
REPLAN/ESCALATE blocks execution; address the verdict and revise the plan before re-review.
Only the user can waive a required review with /review-waive <scope-key> <reason>.
Keep the seven snapshot fields compact. Findings are attached
with provenance and lifecycle evidence; use review_findings to inspect or report a supported
resolution. An auditor's claim about a user instruction is not itself a direct user instruction.
Describe relevant constraints in Goal. Use 'None' for empty fields.
Supply additional context only when needed; decide whether requested information merits another call.
Weigh the short verdict and changes; retain final decisions. Do not call another reviewer merely because
Orche-Advisor completed. Existing watchdog advisors retain their existing responsibilities.`;

const ORCHESTRATE_GUIDANCE = `<system-notice>
Orche-Advisor integration: review applies to execution checkpoints, not every conversational turn.
1. Scope and plan first. Before implementing or dispatching, use the execution gate's current
   requirement. An existing receipt covers unchanged work; do not request another initial-plan
   review just because this orchestration notice appears again.
2. Verified phase transitions and material scope changes require renewed review before execution.
3. Status answers, read-only inspection and discussing new auditor findings do not require a review.
   Findings remain recorded and may invalidate permission for the next mutation or dispatch.
   One review covers overlapping checkpoints. Never review each worker completion or reviewer response.
4. Send only the seven compact snapshot fields. Use actual task state and 'None' for empty fields.
   Wait for the result, weigh it, and continue the task in the same turn; you remain the orchestrator.
   If the reviewer is unavailable, diagnose the error; review remains possible after recovery on
   the same scope without user retry authorization. Never claim an error is a passed review.
   Do not loop on unchanged errors. For REPLAN/ESCALATE, revise the plan before re-review.
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


export function registerOrcheAdvisor(pi: ExtensionAPI, gate = new ReviewGate(), reviewer: typeof runReview = runReview): void {
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
    description: `Request a scope-bound orchestration checkpoint review. Primary only. Required by review gates independently of DEFAULT/ORCHESTRATE; successful results authorize only the current plan, dispatch and finding revision. Omit dispatch to retain staged contracts, pass a task input to replace them, or null to withdraw them and review parent-only work. Withdrawal does not cancel workers. Use the seven snapshot fields; ${AUDITOR_NAME} findings and resolution evidence attach automatically. Failed reviews do not authorize execution.`,
    loadMode: "essential",
    deferrable: false,
    parameters: z
      .object({
        checkpoint: z.enum(CHECKPOINTS),
        dispatch: z.record(z.unknown()).nullable().optional().describe("Omit to retain staged contracts. Supply exact planned task input (context/tasks or a flat task) to replace them. Supply null to withdraw all staged dispatches and review parent-only work; this does not cancel running workers. Empty tasks arrays are invalid."),
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
      const prepared = prepareReviewInput(
        { checkpoint: params.checkpoint, snapshot: params.snapshot },
        collectFindings(primary.sessionManager.getBranch()),
      );
      if (params.dispatch !== undefined) gate.stageDispatch(ctx, params.dispatch);
      const branch = primary.sessionManager.getBranch();
      const capturedScope = gate.scope(ctx);
      if (!capturedScope.dispatchComplete) throw new Error(
        "Legacy dispatch summaries are incomplete. Supply the exact dispatch again, or dispatch: null for parent-only work; no waiver is needed to restage.",
      );
      if (capturedScope.failed) throw new Error(
        "This exact plan was rejected. Address the verdict and revise the committed plan before requesting review. " +
        "Execution remains blocked; only the user can authorize an unchanged retry or waive review.",
      );
      prepared.executionScope = {
        key: capturedScope.key, checkpoint: capturedScope.checkpoint,
        planHash: capturedScope.planHash, dispatchSummary: capturedScope.dispatchSummary,
      };
      const revision = findingRevision(branch);
      const { snapshotHash } = prepared;
      // Reuse only the identical plan/dispatch/finding scope, not just the caller's prose.
      for (let index = branch.length - 1; index >= 0; index--) {
        const entry = branch[index];
        if (
          entry?.type !== "message" ||
          entry.message.role !== "toolResult" ||
          entry.message.toolName !== TOOL ||
          entry.message.isError
        )
          continue;
        const prior = entry.message.details as
          | { role?: string; snapshotHash?: string; scopeKey?: string; findingRevision?: string; model?: string; reused?: boolean }
          | undefined;
        if (prior?.role === ROLE && prior.snapshotHash === snapshotHash &&
            prior.scopeKey === capturedScope.key && prior.findingRevision === revision && !prior.reused &&
            entry.message.content.some(part => part.type === "text" && /^VERDICT: (KEEP|ADJUST)\b/.test(part.text))) {
          gate.complete(ctx, capturedScope, true);
          return {
            content: [
              {
                type: "text",
                text: "Reusing the previous review of this exact execution and finding scope; no model call was made.",
              },
              ...entry.message.content,
            ],
            details: {
              role: ROLE,
              snapshotHash,
              scopeKey: capturedScope.key,
              findingRevision: revision,
              findingsForwarded: 0,
              model: prior.model,
              reused: true,
              usage: null,
            },
          };
        }
      }

      inFlight = true;
      let completedReview: ReviewResult | undefined;
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
        const review = await reviewer(prepared, selection, ctx.modelRegistry, signal);
        completedReview = review;
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
        const scopeStale = gate.scope(ctx).key !== capturedScope.key;
        const result = {
          ...(review.isError ? { isError: true } : {}),
          content: [{ type: "text" as const, text: review.text + (scopeStale ? "\n\nScope changed while review ran; this result does not authorize the new scope." : "") }],
          details: { ...review.details, scopeKey: capturedScope.key, findingRevision: revision, scopeStale },
        };
        // Commit permission only after all fallible review bookkeeping succeeds.
        gate.complete(ctx, capturedScope, !review.isError, review.details.requestId, review.details.failureKind);
        return result;
      } catch (error) {
        gate.complete(ctx, capturedScope, false, completedReview?.details.requestId,
          completedReview?.details.failureKind ?? "provider_error");
        throw error;
      } finally {
        inFlight = false;
      }
    },
  });
}
