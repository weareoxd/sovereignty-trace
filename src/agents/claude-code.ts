import { query, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type {
  CodingAgent,
  CodingAgentEvent,
  CodingAgentResult,
  CodingAgentSession,
  CodingAgentSessionOptions,
  CodingAgentUsage,
} from "./agent.js";
import { createSgServer } from "./sg-tools.js";

/**
 * CodingAgent adapter for the Claude Code SDK (`@anthropic-ai/claude-agent-sdk`).
 * Drives a single `query()` call and normalizes its message stream into
 * CodingAgentEvent.
 */
export class ClaudeCodeAgent implements CodingAgent {
  readonly name = "claude-code";

  startSession(options: CodingAgentSessionOptions): CodingAgentSession {
    return new ClaudeCodeSession(options);
  }
}

/**
 * Backs both `events()` and `result()` with a single consumption of the
 * underlying (single-use) SDK stream. `events()` and `result()` can each be
 * called independently, and `events()` can be called more than once — every
 * consumer reads from the same buffer, driven by at most one underlying
 * `query()` iteration.
 */
class ClaudeCodeSession implements CodingAgentSession {
  private readonly abortController: AbortController;
  private readonly rawStream: AsyncGenerator<SDKMessage, void>;
  private readonly buffered: CodingAgentEvent[] = [];
  private driveStarted = false;
  private driveDone = false;
  private finalResult: CodingAgentResult | undefined;
  private sessionId: string | undefined;
  private resolvedModel: string | undefined;
  private waiters: Array<() => void> = [];

  constructor(options: CodingAgentSessionOptions) {
    this.abortController = new AbortController();
    if (options.signal) {
      if (options.signal.aborted) {
        this.abortController.abort();
      } else {
        options.signal.addEventListener("abort", () => this.abortController.abort(), {
          once: true,
        });
      }
    }

    this.rawStream = query({
      prompt: options.instructions,
      options: {
        cwd: options.cwd,
        model: options.model,
        resume: options.resumeSessionId,
        abortController: this.abortController,
        outputFormat: options.outputSchema
          ? { type: "json_schema", schema: options.outputSchema }
          : undefined,
        // Investigation is read-only by design: no Write/Edit/NotebookEdit.
        // Bash is still included for git/find/grep-style inspection, so
        // treat repositories being assessed as at least semi-trusted input
        // (run untrusted repositories in a container or read-only checkout).
        tools: ["Read", "Grep", "Glob", "Bash"],
        // On-demand Sovereignty Graph knowledge, exposed as
        // sg_search_providers / sg_get_provider / sg_search_policies /
        // sg_get_policy / sg_get_policy_source, plus sg_cite_evidence for
        // repository citations. Not part of the opening instructions — the
        // agent calls these only once it identifies a provider or policy
        // question worth grounding, or has evidence to cite.
        mcpServers: { sg: createSgServer({ repositoryPath: options.cwd }) },
        // There is no human in the loop for a headless assessment run, so
        // permission prompts must be pre-resolved rather than hang.
        permissionMode: "bypassPermissions",
        allowDangerouslySkipPermissions: true,
      },
    });
  }

  async *events(): AsyncIterable<CodingAgentEvent> {
    this.ensureDriving();
    let index = 0;
    for (;;) {
      while (index < this.buffered.length) {
        yield this.buffered[index]!;
        index++;
      }
      if (this.driveDone) return;
      await this.waitForMore();
    }
  }

  async result(): Promise<CodingAgentResult> {
    this.ensureDriving();
    while (!this.driveDone) {
      await this.waitForMore();
    }
    return this.finalResult!;
  }

  async cancel(): Promise<void> {
    if (this.abortController.signal.aborted) return;
    try {
      await this.rawStream.return?.(undefined);
    } finally {
      this.abortController.abort();
    }
  }

  private ensureDriving(): void {
    if (this.driveStarted) return;
    this.driveStarted = true;
    void this.drive();
  }

  private async drive(): Promise<void> {
    for await (const message of this.rawStream) {
      if (message.type === "system" && message.subtype === "init") {
        this.resolvedModel ??= message.model;
      }
      for (const event of toEvents(message)) {
        if (event.type === "session_started") this.sessionId ??= event.sessionId;
        if (event.type === "result") {
          event.result.model ??= this.resolvedModel;
          this.finalResult = event.result;
        }
        this.push(event);
      }
    }

    if (!this.finalResult) {
      this.finalResult = {
        sessionId: this.sessionId ?? "unknown",
        isError: true,
        stopReason: "stream_ended_without_result",
      };
      this.push({ type: "result", result: this.finalResult });
    }

    this.driveDone = true;
    this.notifyWaiters();
  }

  private push(event: CodingAgentEvent): void {
    this.buffered.push(event);
    this.notifyWaiters();
  }

  private notifyWaiters(): void {
    const waiters = this.waiters;
    this.waiters = [];
    for (const waiter of waiters) waiter();
  }

  private waitForMore(): Promise<void> {
    return new Promise((resolve) => this.waiters.push(resolve));
  }
}

function toEvents(message: SDKMessage): CodingAgentEvent[] {
  switch (message.type) {
    case "system": {
      if (message.subtype === "init") {
        return [{ type: "session_started", sessionId: message.session_id }];
      }
      return [];
    }

    case "assistant": {
      const events: CodingAgentEvent[] = [];
      const content = message.message.content;
      const blocks = Array.isArray(content) ? content : [];
      for (const block of blocks) {
        if (block.type === "text") {
          events.push({ type: "text", text: block.text });
        } else if (block.type === "tool_use") {
          events.push({
            type: "tool_use",
            toolName: block.name,
            input: block.input,
            toolUseId: block.id,
          });
        }
      }
      if (message.error) {
        events.push({ type: "error", message: message.error });
      }
      return events;
    }

    case "user": {
      const content = message.message.content;
      const blocks = Array.isArray(content) ? content : [];
      const events: CodingAgentEvent[] = [];
      for (const block of blocks) {
        if (block.type === "tool_result") {
          events.push({
            type: "tool_result",
            toolUseId: block.tool_use_id,
            isError: Boolean(block.is_error),
            output: block.content,
          });
        }
      }
      return events;
    }

    case "result": {
      const usage: CodingAgentUsage = {
        inputTokens: message.usage?.input_tokens,
        outputTokens: message.usage?.output_tokens,
        totalCostUsd: message.total_cost_usd,
      };

      const result: CodingAgentResult =
        message.subtype === "success"
          ? {
              sessionId: message.session_id,
              isError: message.is_error,
              text: message.result,
              structuredOutput: message.structured_output,
              stopReason: message.stop_reason ?? undefined,
              usage,
            }
          : {
              sessionId: message.session_id,
              isError: true,
              stopReason: message.subtype,
              usage,
            };

      return [{ type: "result", result }];
    }

    default:
      return [];
  }
}
