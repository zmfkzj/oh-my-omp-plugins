// OMP 18.1.20 SDK extension; deliberately separate from the passive WATCHDOG roster.
// Model: config.yml -> modelRoles.orche-advisor (independent of default/slow/advisor).
// Install as an OMP package extension. Only DEFAULT's explicit tool call spends tokens.
// Usage is returned in tool-result details.usage, not the native /advisor status panel.
// Disable with disabledExtensions: ["extension-module:orche-advisor"], preserving other entries.
// Checkpoint relevance is a prompt policy; tool-less execution, input limits, primary-only
// access, same-branch snapshot reuse, and overlapping-request rejection are runtime checks.

import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { resolveRoleSelection } from "@oh-my-pi/pi-coding-agent/config/model-resolver";
import { AgentRegistry, MAIN_AGENT_ID } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { CHECKPOINTS, ROLE, TOOL, prepareReviewInput, runReview } from "./src/review.ts";

const DEFAULT_GUIDANCE = `Orche-Advisor is an optional orchestration reviewer, not a worker or second orchestrator.
You retain planning, delegation, implementation integration, verification, and termination responsibility.
Call orche_advisor explicitly only when its expected benefit exceeds its cost at a material checkpoint:
important initial plan; before large fan-out; at least two failures on the same problem; major replan;
important phase boundary; expansion across subsystems; or explicit orchestration escalation.
These checkpoints permit review; they do not require it. Never call just because a worker completed,
for a routine/local task, or again without material new information. Combine overlapping checkpoints.
Send only the seven compact snapshot fields, not conversation history, repository contents, worker logs,
or credentials. Describe relevant constraints in Goal. Use 'None' for empty fields.
Supply additional context only when needed; decide whether requested information merits another call.
Weigh the short verdict and changes; retain final decisions. Do not call another reviewer merely because
Orche-Advisor completed. Existing Advisor and Challenger retain their existing responsibilities.`;

function primarySession(ctx: ExtensionContext) {
  const primary = AgentRegistry.global().get(MAIN_AGENT_ID)?.session;
  return primary?.sessionManager === ctx.sessionManager ? primary : undefined;
}

export default function orcheAdvisor(pi: ExtensionAPI) {
  const z = pi.zod;
  const field = z.string().min(1).max(2000);
  let inFlight = false;

  // Only this explicit tool invokes a model. Lifecycle hooks never request reviews.
  pi.on("session_start", (_event, ctx) => {
    if (!primarySession(ctx)) {
      pi.setActiveTools(pi.getActiveTools().filter((name) => name !== TOOL));
    }
  });
  pi.on("before_agent_start", (event, ctx) => {
    if (primarySession(ctx) && pi.getActiveTools().includes(TOOL)) {
      return { systemPrompt: [...event.systemPrompt, DEFAULT_GUIDANCE] };
    }
  });

  pi.registerTool({
    name: TOOL,
    label: "Orche-Advisor",
    description:
      "Request one orchestration-only checkpoint review using @orche-advisor. DEFAULT only; never for routine worker completion. Send a compact snapshot, not conversation or repository contents. Identical snapshots reuse the prior review without a model call.",
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
      const prepared = prepareReviewInput(params);
      const { snapshotHash } = prepared;
      // Search only local branch metadata; no transcript is passed to the reviewer.
      const branch = primary.sessionManager.getBranch();
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
          | { role?: string; snapshotHash?: string; model?: string; reused?: boolean }
          | undefined;
        if (prior?.role === ROLE && prior.snapshotHash === snapshotHash && !prior.reused) {
          return {
            content: [
              {
                type: "text",
                text: "Reusing the previous review of this snapshot; no model call was made.",
              },
              ...entry.message.content,
            ],
            details: { role: ROLE, snapshotHash, model: prior.model, reused: true, usage: null },
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
        const review = await runReview(prepared, selection, ctx.modelRegistry, signal);
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
