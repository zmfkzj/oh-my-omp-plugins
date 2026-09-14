import type {
  AgentSession,
  ExtensionAPI,
  ExtensionContext,
} from "@oh-my-pi/pi-coding-agent";

export const PARENT_MODEL = "openai-codex/gpt-6-astra";
export const DAYBREAK_MODEL = "openai-codex/gpt-daybreak-blue-latest";

export interface DelegationRequest {
  id: string;
  requestKey: string;
  prompt: string;
  cwd: string;
  sourceModel: string;
  sourceError: string;
  parentSessionId: string;
}

export interface WorkerResult {
  status: "completed" | "failed" | "cancelled";
  output: string;
  error?: string;
  sessionFile?: string;
}

export type WorkerRunner = (
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  parent: AgentSession,
  request: DelegationRequest,
  signal: AbortSignal,
  onProgress: (text: string) => void,
) => Promise<WorkerResult>;
