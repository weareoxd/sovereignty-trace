import type { CodingAgent, CodingAgentSession, CodingAgentSessionOptions } from "./agent.js";

/**
 * Placeholder for a GitHub Copilot SDK adapter. Not implemented yet — kept
 * here so the CodingAgent interface is proven against a second, differently
 * shaped runtime before Copilot support is actually built.
 */
export class CopilotAgent implements CodingAgent {
  readonly name = "copilot";

  startSession(_options: CodingAgentSessionOptions): CodingAgentSession {
    throw new Error(
      "CopilotAgent is not implemented yet. Use ClaudeCodeAgent (src/agents/claude-code.ts).",
    );
  }
}
