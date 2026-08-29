import { resolve } from "node:path";
import type { CodingAgent, CodingAgentEvent, CodingAgentResult } from "./agents/agent.js";
import { buildAssessmentInstructions } from "./assessment/methodology.js";
import { gatherRepositoryInfo } from "./assessment/repository-info.js";
import { sovereigntyAssessmentJsonSchema } from "./assessment/schema.js";
import { validateAssessment, type ValidationResult } from "./assessment/validation.js";
import type { RunInfo } from "./run-info.js";

export interface RunAssessmentOptions {
  agent: CodingAgent;
  repositoryPath: string;
  model?: string;
  resumeSessionId?: string;
  signal?: AbortSignal;
  /**
   * Cancels the session once it has issued more than this many tool calls.
   * A safety valve for a session that gets stuck re-exploring, not a
   * default — leave unset to run without a cap. Implemented generically
   * against the CodingAgentSession interface, so it applies the same way
   * regardless of which CodingAgent runtime is passed in.
   */
  maxToolCalls?: number;
  /** Called for every normalized agent event, e.g. to print progress. */
  onEvent?: (event: CodingAgentEvent) => void;
}

export interface RunAssessmentOutcome {
  agentResult: CodingAgentResult;
  validation: ValidationResult;
  runInfo: RunInfo;
}

/**
 * Runs one end-to-end assessment: builds the methodology instructions,
 * starts a CodingAgent session against the repository, drives it to
 * completion, and validates the structured output it returns.
 *
 * Repository identity, timing, and runtime/model are computed here rather
 * than asked of the coding agent, so they're identical across agent
 * runtimes and don't drift between runs.
 */
export async function runAssessment(options: RunAssessmentOptions): Promise<RunAssessmentOutcome> {
  const repositoryPath = resolve(options.repositoryPath);
  const startedAt = new Date();
  // gatherRepositoryInfo runs first (not in parallel with instructions
  // building) because its output — primary languages, file count,
  // .gitignore patterns — is seeded into the instructions below, so the
  // agent doesn't have to spend its own tool calls rediscovering them.
  const repositoryInfo = await gatherRepositoryInfo(repositoryPath);
  const instructions = await buildAssessmentInstructions({
    repositoryPath,
    primaryLanguages: repositoryInfo.primaryLanguages,
    fileCount: repositoryInfo.fileCount,
    ignoredPatterns: repositoryInfo.ignoredPatterns,
  });

  const session = options.agent.startSession({
    cwd: repositoryPath,
    instructions,
    outputSchema: sovereigntyAssessmentJsonSchema(),
    model: options.model,
    resumeSessionId: options.resumeSessionId,
    signal: options.signal,
  });

  let toolCallCount = 0;
  let cancelledForToolCallCap = false;
  for await (const event of session.events()) {
    options.onEvent?.(event);
    if (event.type === "tool_use") {
      toolCallCount++;
      if (options.maxToolCalls !== undefined && toolCallCount > options.maxToolCalls) {
        cancelledForToolCallCap = true;
        await session.cancel();
        break;
      }
    }
  }

  const agentResult = await session.result();
  const completedAt = new Date();

  if (cancelledForToolCallCap) {
    agentResult.isError = true;
    agentResult.stopReason = `exceeded tool-call cap (${options.maxToolCalls})`;
  }

  const runInfo: RunInfo = {
    repositoryPath,
    repositoryName: repositoryInfo.name,
    commit: repositoryInfo.commit,
    primaryLanguages: repositoryInfo.primaryLanguages,
    assessedAt: startedAt.toISOString(),
    durationMs: completedAt.getTime() - startedAt.getTime(),
    agentName: options.agent.name,
    model: agentResult.model ?? options.model,
    sessionId: agentResult.sessionId,
    usage: agentResult.usage,
  };

  if (agentResult.isError || agentResult.structuredOutput === undefined) {
    return {
      agentResult,
      runInfo,
      validation: {
        valid: false,
        errors: [
          {
            path: "",
            message: agentResult.isError
              ? `Agent session ended in error (stopReason: ${agentResult.stopReason ?? "unknown"}).`
              : "Agent did not return structured output.",
          },
        ],
        warnings: [],
      },
    };
  }

  const validation = await validateAssessment(agentResult.structuredOutput, { repositoryPath });
  return { agentResult, runInfo, validation };
}
