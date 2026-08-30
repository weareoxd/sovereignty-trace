import { resolve } from "node:path";
import type {
  CodingAgent,
  CodingAgentEvent,
  CodingAgentResult,
  CodingAgentSessionOptions,
  CodingAgentUsage,
} from "./agents/agent.js";
import { buildAssessmentInstructions } from "./assessment/methodology.js";
import { buildEvidenceRepairPrompt } from "./assessment/repair.js";
import { gatherRepositoryInfo } from "./assessment/repository-info.js";
import { sovereigntyAssessmentJsonSchema } from "./assessment/schema.js";
import {
  unverifiedEvidence,
  validateAssessment,
  type ValidationResult,
} from "./assessment/validation.js";
import type { RunInfo } from "./run-info.js";

/** Repair rounds attempted when evidence fails verification, unless overridden. */
const DEFAULT_MAX_REPAIR_ROUNDS = 2;

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
   * regardless of which CodingAgent runtime is passed in. Applied per
   * session, so a repair round gets its own budget.
   */
  maxToolCalls?: number;
  /**
   * How many times to hand failed evidence citations back to the agent for
   * correction. Defaults to {@link DEFAULT_MAX_REPAIR_ROUNDS}; 0 disables
   * repair and reports the first result as-is.
   */
  maxRepairRounds?: number;
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
 * completion, validates the structured output it returns, and hands any
 * unverifiable evidence citation back to the same session to correct.
 *
 * The repair rounds exist because the agent's citations are written from
 * memory when it serializes its answer, which is where they go wrong: it
 * still has the session context needed to fix a path it actually read.
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

  const sessionDefaults = {
    cwd: repositoryPath,
    outputSchema: sovereigntyAssessmentJsonSchema(),
    model: options.model,
    signal: options.signal,
  };

  const usageTotals: CodingAgentUsage[] = [];
  let agentResult = await driveSession(options, {
    ...sessionDefaults,
    instructions,
    resumeSessionId: options.resumeSessionId,
  });
  usageTotals.push(agentResult.usage ?? {});

  let validation = await validateAgainstRepository(agentResult, repositoryPath, repositoryInfo.files);

  const maxRepairRounds = options.maxRepairRounds ?? DEFAULT_MAX_REPAIR_ROUNDS;
  let repairRounds = 0;

  while (repairRounds < maxRepairRounds && !options.signal?.aborted) {
    const failures = unverifiedEvidence(validation);
    if (failures.length === 0 || !agentResult.sessionId) break;

    repairRounds++;
    const repaired = await driveSession(options, {
      ...sessionDefaults,
      instructions: await buildEvidenceRepairPrompt(failures),
      resumeSessionId: agentResult.sessionId,
    });
    usageTotals.push(repaired.usage ?? {});

    // A failed repair round leaves the previous assessment standing: it is
    // incomplete, not worthless, and discarding it would lose every finding
    // that did verify.
    if (repaired.isError || repaired.structuredOutput === undefined) break;

    const revalidated = await validateAgainstRepository(
      repaired,
      repositoryPath,
      repositoryInfo.files,
    );
    // Only accept the repair if it parsed; a schema-invalid retry is a
    // regression on a result we already have.
    if (!revalidated.assessment) break;

    agentResult = repaired;
    validation = revalidated;
  }

  const completedAt = new Date();

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
    usage: sumUsage(usageTotals),
    repairRounds,
  };

  return { agentResult, runInfo, validation };
}

async function validateAgainstRepository(
  agentResult: CodingAgentResult,
  repositoryPath: string,
  files: string[],
): Promise<ValidationResult> {
  if (agentResult.isError || agentResult.structuredOutput === undefined) {
    return {
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
      evidenceChecks: [],
      taintedFindings: [],
    };
  }

  return validateAssessment(agentResult.structuredOutput, { repositoryPath, files });
}

/** Runs one session to completion, enforcing the per-session tool-call cap. */
async function driveSession(
  options: RunAssessmentOptions,
  sessionOptions: CodingAgentSessionOptions,
): Promise<CodingAgentResult> {
  const session = options.agent.startSession(sessionOptions);

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

  const result = await session.result();
  if (cancelledForToolCallCap) {
    result.isError = true;
    result.stopReason = `exceeded tool-call cap (${options.maxToolCalls})`;
  }
  return result;
}

/** Totals usage across the initial session and any repair rounds. */
function sumUsage(usages: CodingAgentUsage[]): CodingAgentUsage | undefined {
  const present = usages.filter(
    (usage) =>
      usage.inputTokens !== undefined ||
      usage.outputTokens !== undefined ||
      usage.totalCostUsd !== undefined,
  );
  if (present.length === 0) return undefined;

  const total = (pick: (usage: CodingAgentUsage) => number | undefined): number | undefined => {
    const values = present.map(pick).filter((value): value is number => value !== undefined);
    return values.length > 0 ? values.reduce((sum, value) => sum + value, 0) : undefined;
  };

  return {
    inputTokens: total((usage) => usage.inputTokens),
    outputTokens: total((usage) => usage.outputTokens),
    totalCostUsd: total((usage) => usage.totalCostUsd),
  };
}
