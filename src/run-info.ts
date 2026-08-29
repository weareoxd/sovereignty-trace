import type { CodingAgentUsage } from "./agents/agent.js";

/**
 * Facts about one assessment run that are knowable without asking the
 * coding agent — repository identity, timing, and which runtime/model
 * produced the result. Computed by runAssessment, not by the model, so it
 * doesn't vary between runs or agent runtimes the way a model-authored
 * field would.
 */
export interface RunInfo {
  repositoryPath: string;
  repositoryName: string;
  /** Git commit SHA of the repository at assessment time, if it's a git checkout. */
  commit?: string;
  primaryLanguages: string[];
  /** ISO 8601 timestamp of when the session started. */
  assessedAt: string;
  durationMs: number;
  /** CodingAgent.name of the runtime that ran this session, e.g. "claude-code". */
  agentName: string;
  /** Resolved model identifier, when the runtime reports one. */
  model?: string;
  sessionId: string;
  usage?: CodingAgentUsage;
}
