import { resolve } from "node:path";
import type {
  CodingAgent,
  CodingAgentEvent,
  CodingAgentResult,
  CodingAgentSessionOptions,
  CodingAgentUsage,
} from "./agents/agent.js";
import { buildAssessmentInstructions } from "./assessment/methodology.js";
import { gatherRepositoryInfo } from "./assessment/repository-info.js";
import { assessmentDraftJsonSchema } from "./assessment/schema.js";
import { validateAssessment, type ValidationResult } from "./assessment/validation.js";
import type { RunInfo } from "./run-info.js";

/** Retries attempted when the agent's answer doesn't parse, unless overridden. */
const DEFAULT_MAX_RETRIES = 1;

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
   * How many times to ask again when the agent's answer doesn't conform to the
   * schema. Defaults to {@link DEFAULT_MAX_RETRIES}; 0 reports the first result
   * as-is.
   *
   * This no longer covers evidence. Citations are resolved against the
   * repository in ./assessment/hydrate-evidence.ts, so a bad one is dropped
   * there rather than sent back for another round.
   */
  maxRetries?: number;
  /** Called for every normalized agent event, e.g. to print progress. */
  onEvent?: (event: CodingAgentEvent) => void;
}

export interface RunAssessmentOutcome {
  agentResult: CodingAgentResult;
  validation: ValidationResult;
  runInfo: RunInfo;
}

/**
 * Runs one end-to-end assessment.
 *
 * The agent's session produces observations. Everything derived from them —
 * the quoted evidence, the provider residency, the risk levels, the policy
 * coverage — is computed here, in ./assessment/validation.ts and the modules
 * it calls. Given the same draft, this half of the pipeline produces the same
 * document every time.
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
    outputSchema: await assessmentDraftJsonSchema(),
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

  const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
  let repairRounds = 0;

  // Only a draft that didn't parse is worth asking about again. Dropped
  // citations and unanswered categories are recorded and reported; sending the
  // whole document back for those re-rolled every other field along with them.
  while (repairRounds < maxRetries && !validation.assessment && !options.signal?.aborted) {
    if (!agentResult.sessionId) break;

    repairRounds++;
    const retried = await driveSession(options, {
      ...sessionDefaults,
      instructions: buildSchemaRetryPrompt(validation.errors),
      resumeSessionId: agentResult.sessionId,
    });
    usageTotals.push(retried.usage ?? {});

    if (retried.isError || retried.structuredOutput === undefined) break;

    const revalidated = await validateAgainstRepository(
      retried,
      repositoryPath,
      repositoryInfo.files,
    );
    if (!revalidated.assessment) break;

    agentResult = retried;
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
      droppedEvidence: [],
      droppedFindings: [],
    };
  }

  return validateAssessment(agentResult.structuredOutput, { repositoryPath, files });
}

/** Asks for the answer again, naming what didn't fit the schema. */
function buildSchemaRetryPrompt(errors: { path: string; message: string }[]): string {
  const items = errors.slice(0, 20).map((error) => `- \`${error.path || "(root)"}\`: ${error.message}`);
  return [
    "Your answer did not conform to the output schema for this session, so it could not be used.",
    "",
    "What didn't fit:",
    "",
    ...items,
    "",
    "Return the complete assessment again, conforming to the same schema. Keep the findings you",
    "already made; this pass is only about the shape of the answer.",
  ].join("\n");
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
