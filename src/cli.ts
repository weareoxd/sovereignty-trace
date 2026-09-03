#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { platform } from "node:os";
import { Command } from "commander";
import type { CodingAgent, CodingAgentEvent } from "./agents/agent.js";
import { ClaudeCodeAgent } from "./agents/claude-code.js";
import { SwivalAgent } from "./agents/swival.js";
import { renderMarkdownReport } from "./report.js";
import { renderHtmlReport } from "./report-html.js";
import { runAssessment } from "./run-assessment.js";

const program = new Command();

program
  .name("sovereignty-trace")
  .description("Data-sovereignty assessments of software repositories, run by a coding agent.")
  .version("0.1.0");

program
  .command("assess")
  .description("Assess a repository's data-sovereignty posture")
  .argument("<repository>", "path to the repository to assess")
  .option(
    "-a, --agent <runtime>",
    "coding agent runtime to run the assessment with: claude-code (default) or swival",
    "claude-code",
  )
  .option("-m, --model <model>", "model identifier to pass to the coding agent")
  .option("-r, --resume <sessionId>", "resume a previous assessment session")
  .option(
    "-t, --max-tool-calls <n>",
    "cancel the session if it exceeds this many tool calls (safety valve for a stuck session; no cap by default)",
    (value) => parseInt(value, 10),
  )
  .option(
    "--max-retries <n>",
    "how many times to ask again when the agent's answer doesn't match the schema (default 1; 0 disables)",
    (value) => parseInt(value, 10),
  )
  .option("-o, --out <file>", "write the Markdown report to this file instead of stdout")
  .option("--json <file>", "also write the raw structured assessment as JSON to this file")
  .option(
    "--html [file]",
    "also write an HTML report and open it automatically once the assessment completes",
  )
  .option("--no-open", "when used with --html, write the HTML report but don't open it")
  .option(
    "--transcript [file]",
    "also write the full tool-call transcript as JSONL (one CodingAgentEvent per line)",
  )
  .option("-q, --quiet", "suppress progress output", false)
  .action(async (repository: string, opts) => {
    const repositoryPath = resolve(repository);
    if (!existsSync(repositoryPath)) {
      console.error(`Repository path does not exist: ${repositoryPath}`);
      process.exitCode = 1;
      return;
    }

    const agent = resolveAgent(opts.agent);
    if (!agent) {
      console.error(`Unknown --agent runtime "${opts.agent}". Expected "claude-code" or "swival".`);
      process.exitCode = 1;
      return;
    }
    const controller = new AbortController();
    process.once("SIGINT", () => controller.abort());

    const transcript: CodingAgentEvent[] = [];

    const outcome = await runAssessment({
      agent,
      repositoryPath,
      model: opts.model,
      resumeSessionId: opts.resume,
      maxToolCalls: opts.maxToolCalls,
      maxRetries: opts.maxRetries,
      signal: controller.signal,
      onEvent: (event) => {
        if (opts.transcript) transcript.push(event);
        if (!opts.quiet) printProgress(event);
      },
    });

    if (opts.transcript) {
      const transcriptPath =
        typeof opts.transcript === "string" ? resolve(opts.transcript) : defaultTranscriptPath(repositoryPath);
      await mkdir(dirname(transcriptPath), { recursive: true });
      await writeFile(transcriptPath, transcript.map((event) => JSON.stringify(event)).join("\n") + "\n", "utf8");
      console.error(`Tool-call transcript written to ${transcriptPath}`);
    }

    const { agentResult, validation, runInfo } = outcome;

    if (!opts.quiet) {
      console.error(`\nSession: ${agentResult.sessionId}`);
      if (agentResult.usage?.totalCostUsd !== undefined) {
        console.error(`Estimated cost: $${agentResult.usage.totalCostUsd.toFixed(4)}`);
      }
    }

    if (!validation.assessment) {
      console.error("Assessment failed:");
      for (const error of validation.errors) {
        console.error(`  - ${error.path ? `${error.path}: ` : ""}${error.message}`);
      }
      process.exitCode = 1;
      return;
    }

    const report = renderMarkdownReport(validation.assessment, validation, runInfo);

    if (opts.out) {
      await writeFile(opts.out, report, "utf8");
      console.error(`Report written to ${opts.out}`);
    } else {
      console.log(report);
    }

    if (opts.json) {
      await writeFile(opts.json, JSON.stringify(validation.assessment, null, 2), "utf8");
      console.error(`Structured assessment written to ${opts.json}`);
    }

    if (opts.html) {
      const htmlPath = typeof opts.html === "string" ? resolve(opts.html) : defaultHtmlReportPath(repositoryPath);
      const html = renderHtmlReport(validation.assessment, validation, runInfo);
      await mkdir(dirname(htmlPath), { recursive: true });
      await writeFile(htmlPath, html, "utf8");
      console.error(`HTML report written to ${htmlPath}`);
      if (opts.open) openInBrowser(htmlPath);
    }

    if (!validation.valid) {
      const parts: string[] = [];
      if (validation.droppedEvidence.length > 0) {
        parts.push(`${validation.droppedEvidence.length} citation(s) dropped`);
      }
      if (validation.droppedFindings.length > 0) {
        parts.push(`${validation.droppedFindings.length} finding(s) removed for lack of evidence`);
      }
      const coverage = validation.warnings.length - validation.droppedEvidence.length - validation.droppedFindings.length;
      if (coverage > 0) parts.push(`${coverage} coverage gap(s)`);

      console.error(`\nThe assessment is incomplete: ${parts.join(", ")}. See the report above.`);
      process.exitCode = 1;
    }
  });

program.parseAsync(process.argv);

function resolveAgent(runtime: string): CodingAgent | undefined {
  switch (runtime) {
    case "claude-code":
      return new ClaudeCodeAgent();
    case "swival":
      return new SwivalAgent();
    default:
      return undefined;
  }
}

function printProgress(event: CodingAgentEvent): void {
  switch (event.type) {
    case "session_started":
      console.error(`Session started: ${event.sessionId}`);
      break;
    case "tool_use":
      console.error(`  ${event.toolName} ${summarizeToolInput(event.input)}`);
      break;
    case "notice":
      console.error(`  ${event.message}`);
      break;
    case "error":
      console.error(`  error: ${event.message}`);
      break;
    default:
      break;
  }
}

function summarizeToolInput(input: unknown): string {
  if (input && typeof input === "object") {
    const record = input as Record<string, unknown>;
    for (const key of ["command", "pattern", "file_path", "path"]) {
      const value = record[key];
      if (typeof value === "string") return value.slice(0, 120);
    }
  }
  return "";
}

function defaultHtmlReportPath(repositoryPath: string): string {
  const slug = basename(repositoryPath).replace(/[^a-zA-Z0-9._-]/g, "-") || "repository";
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  return join(process.cwd(), "output", `sovereignty-assessment-${slug}-${timestamp}.html`);
}

function defaultTranscriptPath(repositoryPath: string): string {
  const slug = basename(repositoryPath).replace(/[^a-zA-Z0-9._-]/g, "-") || "repository";
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  return join(process.cwd(), "output", `sovereignty-assessment-${slug}-${timestamp}-transcript.jsonl`);
}

/** Opens a file in the platform's default browser/handler; failures are logged, not fatal. */
function openInBrowser(path: string): void {
  const plat = platform();
  try {
    const child =
      plat === "darwin"
        ? spawn("open", [path], { detached: true, stdio: "ignore" })
        : plat === "win32"
          ? spawn("cmd", ["/c", "start", "", path], { detached: true, stdio: "ignore", windowsHide: true })
          : spawn("xdg-open", [path], { detached: true, stdio: "ignore" });
    child.on("error", (err) => {
      console.error(`Could not open HTML report automatically: ${err.message}`);
    });
    child.unref();
  } catch (err) {
    console.error(`Could not open HTML report automatically: ${(err as Error).message}`);
  }
}
