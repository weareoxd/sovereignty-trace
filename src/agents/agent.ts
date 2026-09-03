/**
 * CodingAgent is the boundary between Sovereignty Trace and whatever coding
 * agent runtime actually investigates a repository (Claude Code, Codex,
 * Copilot, ...). It normalizes only the capabilities Sovereignty Trace
 * needs: starting a session against a repository, supplying instructions,
 * streaming events, resuming, cancellation, and requesting structured
 * output. It does not try to hide runtime-specific behavior beyond that.
 */

/** A JSON Schema object, passed through to the runtime as-is. */
export type JsonSchema = Record<string, unknown>;

export interface CodingAgentSessionOptions {
  /** Absolute path to the repository the agent should investigate. */
  cwd: string;

  /** Instructions establishing the agent's task, given as the session's opening prompt. */
  instructions: string;

  /**
   * When set, the runtime is asked to constrain its final answer to this
   * JSON Schema and return it as `CodingAgentResult.structuredOutput`.
   * Runtimes that cannot enforce this should still populate
   * `structuredOutput` on a best-effort basis (e.g. by parsing the final
   * message as JSON) or leave it undefined.
   */
  outputSchema?: JsonSchema;

  /** Resume a previous session by its runtime-assigned id, instead of starting fresh. */
  resumeSessionId?: string;

  /** Runtime-specific model identifier. Optional; runtimes may apply a default. */
  model?: string;

  /** Aborts the session when triggered. Equivalent to calling `cancel()`. */
  signal?: AbortSignal;
}

export type CodingAgentEvent =
  | { type: "session_started"; sessionId: string }
  | { type: "text"; text: string }
  /**
   * Progress from the adapter itself rather than the model, e.g. an answer
   * being sent back for correction. Distinct from `text`, which is the
   * model's own output and accumulates into the final answer.
   */
  | { type: "notice"; message: string }
  | { type: "tool_use"; toolName: string; input: unknown; toolUseId: string }
  | { type: "tool_result"; toolUseId: string; isError: boolean; output: unknown }
  | { type: "error"; message: string }
  | { type: "result"; result: CodingAgentResult };

export interface CodingAgentUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalCostUsd?: number;
}

export interface CodingAgentResult {
  sessionId: string;
  /** True if the session ended in an error or was cut short. */
  isError: boolean;
  /** Final assistant text, when the runtime produced one. */
  text?: string;
  /**
   * Parsed structured output conforming to the requested `outputSchema`,
   * when the runtime was able to produce one.
   */
  structuredOutput?: unknown;
  /** Runtime-specific reason the session stopped, if reported. */
  stopReason?: string;
  usage?: CodingAgentUsage;
  /** Resolved model identifier the runtime actually used, when it reports one. */
  model?: string;
}

/** A single, possibly still-running, investigation session. */
export interface CodingAgentSession {
  /**
   * Async iterator of normalized events. Consuming it drives the session to
   * completion; the final `result` event carries the same value that
   * `result()` resolves to.
   */
  events(): AsyncIterable<CodingAgentEvent>;

  /** Resolves once the session reaches a terminal state. */
  result(): Promise<CodingAgentResult>;

  /** Requests cancellation of a running session. Safe to call more than once. */
  cancel(): Promise<void>;
}

/** A runtime capable of running CodingAgent sessions. */
export interface CodingAgent {
  /** Stable identifier for the runtime, e.g. "claude-code". */
  readonly name: string;

  /** Starts a new investigation session. Does not block until completion. */
  startSession(options: CodingAgentSessionOptions): CodingAgentSession;
}
