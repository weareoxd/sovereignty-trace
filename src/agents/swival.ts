import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  CodingAgent,
  CodingAgentEvent,
  CodingAgentResult,
  CodingAgentSession,
  CodingAgentSessionOptions,
} from "./agent.js";

/**
 * CodingAgent adapter for swival (https://swival.dev), a CLI coding agent
 * driven here over the Agent Client Protocol (`swival --acp`): newline-
 * delimited JSON-RPC 2.0 on stdio, the same protocol Zed uses to drive
 * agents. Unlike ClaudeCodeAgent (an in-process SDK call), this adapter
 * spawns and talks to a real child process.
 *
 * Three things confirmed empirically against swival 1.0.41 while building
 * this (not fully documented, so re-verify against future versions):
 * - ACP framing is one JSON object per line, *not* LSP-style
 *   Content-Length-prefixed framing.
 * - `session/new`'s `mcpServers` param is rejected outright ("ACP-provided
 *   MCP servers are not supported by this agent") — MCP servers must instead
 *   be declared in a `--mcp-config` JSON file passed as a CLI flag when the
 *   process is spawned. See sgMcpConfig() below.
 * - When asked for a large final JSON answer, the underlying model tends to
 *   draft it into a scratch file with a write tool rather than restate it in
 *   its final chat message — observed twice against different repos, each
 *   time with a different, unrequested filename. Left alone, that reliably
 *   produces a session that ends cleanly (`stopReason: "end_turn"`) but
 *   carries no usable answer, and the draft file lands inside the repository
 *   being assessed. See buildPromptText() / resolveFinalAnswer() below.
 */
export class SwivalAgent implements CodingAgent {
  readonly name = "swival";

  constructor(private readonly binary: string = "swival") {}

  startSession(options: CodingAgentSessionOptions): CodingAgentSession {
    return new SwivalSession(options, this.binary);
  }
}

const SG_MCP_SERVER_PATH = join(dirname(fileURLToPath(import.meta.url)), "sg-mcp-server.js");

interface JsonRpcMessage {
  jsonrpc: "2.0";
  id?: number;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string };
}

class SwivalSession implements CodingAgentSession {
  private readonly buffered: CodingAgentEvent[] = [];
  private driveStarted = false;
  private driveDone = false;
  private finalResult: CodingAgentResult | undefined;
  private sessionId: string | undefined;
  private waiters: Array<() => void> = [];
  private cancelRequested = false;
  /** Text chunks belonging to the most recent (final) assistant message run, reset by intervening tool calls. */
  private latestAnswerText: string[] = [];

  private child: ChildProcessWithoutNullStreams | undefined;
  private nextRequestId = 1;
  private readonly pending = new Map<
    number,
    { resolve: (value: JsonRpcMessage) => void; reject: (error: Error) => void }
  >();
  private stderrTail = "";

  constructor(
    private readonly options: CodingAgentSessionOptions,
    private readonly binary: string,
  ) {
    if (options.resumeSessionId) {
      throw new Error(
        "SwivalAgent does not support resuming a previous session: swival's ACP server " +
          `reports agentCapabilities.loadSession: false (as of swival 1.0.41). Requested resume id: ${options.resumeSessionId}`,
      );
    }
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
    if (this.cancelRequested) return;
    this.cancelRequested = true;
    if (this.sessionId && this.child && !this.child.killed) {
      this.notify("session/cancel", { sessionId: this.sessionId });
    } else {
      this.child?.kill();
    }
  }

  private ensureDriving(): void {
    if (this.driveStarted) return;
    this.driveStarted = true;
    void this.drive();
  }

  private async drive(): Promise<void> {
    let scratchDir: string | undefined;
    try {
      // Shared by the MCP config file (read by swival at startup) and, when
      // outputSchema is set, the final-answer file swival is granted write
      // access to below — one temp dir, cleaned up together in `finally`.
      scratchDir = await mkdtemp(join(tmpdir(), "sovereignty-graph-swival-"));
      const mcpConfigPath = join(scratchDir, "mcp.json");
      await writeFile(mcpConfigPath, sgMcpConfig(), "utf8");
      const outputFilePath = this.options.outputSchema
        ? join(scratchDir, "assessment-output.json")
        : undefined;

      this.spawnChild(mcpConfigPath, scratchDir);
      this.watchAbortSignal();

      await this.request("initialize", { protocolVersion: 1, clientCapabilities: {} });

      const sessionNew = await this.request("session/new", {
        cwd: this.options.cwd,
        // ACP-supplied mcpServers are rejected by swival; MCP is wired via
        // the --mcp-config file instead (see spawnChild).
        mcpServers: [],
      });
      const sessionId = (sessionNew.result as { sessionId: string }).sessionId;
      this.sessionId = sessionId;
      this.push({ type: "session_started", sessionId });

      const promptText = buildPromptText(this.options.instructions, this.options.outputSchema, outputFilePath);
      const promptResponse = await this.request("session/prompt", {
        sessionId,
        prompt: [{ type: "text", text: promptText }],
      });

      const answer = await this.resolveFinalAnswer(sessionId, promptResponse, outputFilePath);
      this.finalResult = this.buildResult(sessionId, answer);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.push({ type: "error", message });
      this.finalResult = {
        sessionId: this.sessionId ?? "unknown",
        isError: true,
        stopReason: message,
      };
    } finally {
      this.push({ type: "result", result: this.finalResult! });
      this.driveDone = true;
      this.notifyWaiters();
      this.child?.kill();
      if (scratchDir) await rm(scratchDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  /**
   * Extracts the final structured answer, in order of preference: the
   * designated output file (the primary channel — see buildPromptText),
   * then the trailing chat text (in case the model answered directly
   * despite being told to use the file), then — only if both come up
   * empty — one corrective follow-up turn asking for the JSON in chat.
   * Each step is tried only if the previous one failed to parse.
   */
  private async resolveFinalAnswer(
    sessionId: string,
    promptResponse: JsonRpcMessage,
    outputFilePath: string | undefined,
  ): Promise<{ error?: string; stopReason: string | undefined; text: string; structuredOutput: unknown }> {
    if (promptResponse.error) {
      return { error: promptResponse.error.message, stopReason: undefined, text: "", structuredOutput: undefined };
    }

    let stopReason = (promptResponse.result as { stopReason?: string } | undefined)?.stopReason;
    let text = this.latestAnswerText.join("");

    if (!this.options.outputSchema) {
      return { stopReason, text, structuredOutput: undefined };
    }

    let structuredOutput = outputFilePath ? await tryReadJsonFile(outputFilePath) : undefined;
    structuredOutput ??= tryParseJson(text);

    if (structuredOutput === undefined && stopReason === "end_turn") {
      const nudgeResponse = await this.request("session/prompt", {
        sessionId,
        prompt: [{ type: "text", text: buildNudgeText() }],
      });
      stopReason = (nudgeResponse.result as { stopReason?: string } | undefined)?.stopReason;
      text = this.latestAnswerText.join("");
      structuredOutput = outputFilePath ? await tryReadJsonFile(outputFilePath) : undefined;
      structuredOutput ??= tryParseJson(text);
    }

    return { stopReason, text, structuredOutput };
  }

  private spawnChild(mcpConfigPath: string, writableScratchDir: string): void {
    const args: string[] = [];
    if (this.options.model) args.push("--model", this.options.model);
    args.push(
      "--no-skills",
      "--no-memory",
      "--no-history",
      "--no-continue",
      "--no-a2a",
      "--mcp-config",
      mcpConfigPath,
      // Write access to the scratch dir only — the target repository stays
      // at swival's default workspace access, which does not include this
      // directory, so the model's own draft-then-answer file lands outside
      // the repo being assessed instead of inside it.
      "--add-dir",
      writableScratchDir,
      "--acp",
    );

    this.child = spawn(this.binary, args, { cwd: this.options.cwd, stdio: ["pipe", "pipe", "pipe"] });

    this.child.on("error", (err) => {
      this.failAllPending(new Error(`Failed to launch swival ("${this.binary}"): ${err.message}`));
    });
    this.child.on("exit", (code, signal) => {
      if (this.driveDone) return;
      this.failAllPending(
        new Error(
          `swival process exited before returning a result (code ${code ?? "null"}, signal ${signal ?? "null"}). Stderr tail: ${this.stderrTail.slice(-500)}`,
        ),
      );
    });

    this.child.stderr.setEncoding("utf8");
    this.child.stderr.on("data", (chunk: string) => {
      this.stderrTail = (this.stderrTail + chunk).slice(-4000);
    });

    const rl = createInterface({ input: this.child.stdout });
    rl.on("line", (line) => {
      if (!line.trim()) return;
      let message: JsonRpcMessage;
      try {
        message = JSON.parse(line) as JsonRpcMessage;
      } catch {
        return; // stray non-JSON-RPC output; ACP guarantees stdout carries only frames, but don't crash on it
      }
      this.handleMessage(message);
    });
  }

  private watchAbortSignal(): void {
    const signal = this.options.signal;
    if (!signal) return;
    if (signal.aborted) {
      void this.cancel();
    } else {
      signal.addEventListener("abort", () => void this.cancel(), { once: true });
    }
  }

  private handleMessage(message: JsonRpcMessage): void {
    if (message.method === "session/update") {
      for (const event of toSessionUpdateEvents(message.params)) this.push(event);
      return;
    }
    if (typeof message.id === "number") {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      pending.resolve(message);
    }
    // Other server->client requests/notifications (e.g. authenticate) aren't
    // expected in swival's documented ACP support; ignore anything else.
  }

  private request(method: string, params: unknown): Promise<JsonRpcMessage> {
    const id = this.nextRequestId++;
    const promise = new Promise<JsonRpcMessage>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
    this.write({ jsonrpc: "2.0", id, method, params });
    return promise;
  }

  private notify(method: string, params: unknown): void {
    this.write({ jsonrpc: "2.0", method, params });
  }

  private write(message: JsonRpcMessage): void {
    this.child!.stdin.write(JSON.stringify(message) + "\n");
  }

  private failAllPending(error: Error): void {
    for (const { reject } of this.pending.values()) reject(error);
    this.pending.clear();
  }

  private buildResult(
    sessionId: string,
    answer: { error?: string; stopReason: string | undefined; text: string; structuredOutput: unknown },
  ): CodingAgentResult {
    if (answer.error) {
      return { sessionId, isError: true, stopReason: answer.error };
    }

    return {
      sessionId,
      isError: answer.stopReason !== "end_turn",
      text: answer.text || undefined,
      structuredOutput: answer.structuredOutput,
      stopReason: answer.stopReason,
      // swival's ACP protocol doesn't report back which model it resolved to
      // when none is requested; this is only the model we asked for.
      model: this.options.model,
    };
  }

  private push(event: CodingAgentEvent): void {
    if (event.type === "text") this.latestAnswerText.push(event.text);
    else if (event.type === "tool_use") this.latestAnswerText = [];
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

function sgMcpConfig(): string {
  return JSON.stringify(
    { mcpServers: { sg: { command: process.execPath, args: [SG_MCP_SERVER_PATH] } } },
    null,
    2,
  );
}

/**
 * swival's ACP server has no equivalent of Claude Code's `outputFormat:
 * json_schema` — there's no protocol-level way to constrain the model's
 * final answer. Rather than fight the underlying model's tendency to draft
 * a long structured answer into a file with a write tool (see the adapter's
 * top-of-file comment), this gives it exactly one file to do that in:
 * `outputFilePath`, inside the scratch dir swival was granted write access
 * to via `--add-dir` — outside the repository being assessed. `resolveFinalAnswer()`
 * reads that file first, falls back to best-effort parsing the chat message
 * (in case the model answers directly despite the instruction), and finally
 * sends one corrective nudge if both come up empty. `runAssessment` already
 * treats a missing `structuredOutput` as a failed assessment.
 */
function buildPromptText(
  instructions: string,
  outputSchema: Record<string, unknown> | undefined,
  outputFilePath: string | undefined,
): string {
  const sections = [instructions];

  if (outputSchema && outputFilePath) {
    sections.push(
      "---",
      `Write your final answer as a single JSON object to exactly this file: ${outputFilePath}\n\n` +
        "That file must contain only the JSON object: no markdown code fence, no prose before or " +
        "after it. It must conform to this JSON Schema:",
      JSON.stringify(outputSchema, null, 2),
    );
  } else if (outputSchema) {
    sections.push(
      "---",
      "Respond with your final answer as a single JSON object and nothing else: " +
        "no markdown code fence, no prose before or after it. It must conform to this JSON Schema:",
      JSON.stringify(outputSchema, null, 2),
    );
  }

  // Unlike the Claude Code adapter, which enforces read-only investigation
  // by simply not including Write/Edit in its tool list, swival's workspace
  // file-access policy doesn't have a read-only mode for the repository
  // itself (see the README's security note) — a prompt instruction is the
  // only enforcement available for that, and it's placed last, after the
  // schema, because smaller local models weigh the most recent instructions
  // most heavily; a version of this line sandwiched mid-prompt was
  // empirically observed not to stop a local model from writing and
  // deleting a file mid-assessment.
  sections.push(
    "---",
    "This is a strictly read-only investigation of the repository you were given as your " +
      "working directory. You must not call any file-writing, file-editing, or file-deleting " +
      "tool against anything inside that repository, for any reason, at any point in this " +
      "task, even temporarily or to record notes." +
      (outputFilePath
        ? ` The one exception is the final-answer file above (${outputFilePath}), which is ` +
          "outside the repository — that is the only file you may write, anywhere, and only " +
          "once, as your last action."
        : " If you want to note something, put it only in your final answer text."),
  );

  return sections.join("\n\n");
}

/** Sent once, only if neither the output file nor the chat message parsed as JSON. */
function buildNudgeText(): string {
  return (
    "Your previous turn ended without a usable final answer: the output file was missing, " +
    "empty, or not valid JSON, and no JSON was found in your reply either. Respond now with " +
    "your complete final answer as a single JSON object directly in this chat message — no " +
    "file writes, no markdown code fence, no prose before or after it — conforming to the " +
    "JSON Schema given earlier."
  );
}

async function tryReadJsonFile(path: string): Promise<unknown> {
  try {
    return tryParseJson(await readFile(path, "utf8"));
  } catch {
    return undefined;
  }
}

function tryParseJson(text: string): unknown {
  const trimmed = text.trim();
  const candidates = [trimmed, stripCodeFence(trimmed), largestBraceSpan(trimmed)].filter(
    (candidate): candidate is string => Boolean(candidate),
  );
  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate);
    } catch {
      continue;
    }
  }
  return undefined;
}

function stripCodeFence(text: string): string | undefined {
  const match = /^```(?:json)?\s*([\s\S]*?)\s*```$/.exec(text);
  return match?.[1];
}

function largestBraceSpan(text: string): string | undefined {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  return start !== -1 && end > start ? text.slice(start, end + 1) : undefined;
}

function toSessionUpdateEvents(params: unknown): CodingAgentEvent[] {
  const update = (params as { update?: Record<string, unknown> } | undefined)?.update;
  if (!update) return [];

  switch (update.sessionUpdate) {
    case "agent_message_chunk": {
      const content = update.content as { type: string; text?: string } | undefined;
      return content?.type === "text" && content.text ? [{ type: "text", text: content.text }] : [];
    }

    case "tool_call": {
      return [
        {
          type: "tool_use",
          toolName: String(update.title ?? update.kind ?? "unknown"),
          input: update.rawInput,
          toolUseId: String(update.toolCallId),
        },
      ];
    }

    case "tool_call_update": {
      if (update.status === "in_progress" || update.status === "pending") return [];
      const items = Array.isArray(update.content) ? update.content : [];
      const texts = items
        .map((item: { content?: { type?: string; text?: string } }) => item.content)
        .filter((c): c is { type?: string; text?: string } => Boolean(c) && c!.type === "text")
        .map((c) => c.text ?? "");
      return [
        {
          type: "tool_result",
          toolUseId: String(update.toolCallId),
          isError: update.status !== "completed",
          output: texts.join("\n"),
        },
      ];
    }

    default:
      // available_commands_update, plan updates, etc. — not part of the
      // normalized CodingAgentEvent vocabulary; SG doesn't need them.
      return [];
  }
}
