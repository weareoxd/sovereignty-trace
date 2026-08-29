import type { CodingAgent, CodingAgentSession, CodingAgentSessionOptions } from "./agent.js";

/**
 * Placeholder for an OpenAI Codex SDK adapter. Not implemented yet — kept
 * here so the CodingAgent interface is proven against a second, differently
 * shaped runtime before Codex support is actually built.
 */
export class CodexAgent implements CodingAgent {
  readonly name = "codex";

  startSession(_options: CodingAgentSessionOptions): CodingAgentSession {
    throw new Error(
      "CodexAgent is not implemented yet. Use ClaudeCodeAgent (src/agents/claude-code.ts).",
    );
  }
}
