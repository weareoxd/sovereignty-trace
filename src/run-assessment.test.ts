import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, test } from "node:test";
import type {
  CodingAgent,
  CodingAgentEvent,
  CodingAgentResult,
  CodingAgentSession,
  CodingAgentSessionOptions,
} from "./agents/agent.js";
import { runAssessment } from "./run-assessment.js";

const REAL_FILE = "backend/src/auth/auth.jwt-strategy.ts";
const REAL_SNIPPET = "export class JwtStrategy extends PassportStrategy(Strategy) {";
const HALLUCINATED_FILE = "backend/src/common/guards/auth.jwt-strategy.ts";

let repositoryPath: string;

before(async () => {
  repositoryPath = await mkdtemp(join(tmpdir(), "sg-run-"));
  const absolute = join(repositoryPath, REAL_FILE);
  await mkdir(dirname(absolute), { recursive: true });
  await writeFile(absolute, `${REAL_SNIPPET}\n  constructor() {}\n}\n`, "utf8");
});

after(async () => {
  await rm(repositoryPath, { recursive: true, force: true });
});

function draftCiting(file: string) {
  return {
    summary: "Test assessment.",
    components: [
      {
        category: "authentication_and_identity",
        summary: "Auth via BC Gov SSO.",
        findings: [
          {
            name: "Authentication via BC Government SSO (Keycloak)",
            description: "Validates Keycloak-issued JWTs.",
            providerId: "bcgov-sso",
            classification: "personal_information",
            activePath: true,
            evidence: [{ file, lines: "1" }],
          },
        ],
      },
    ],
    policyAlignment: [],
  };
}

function resultWith(structuredOutput: unknown, sessionId = "session-1"): CodingAgentResult {
  return { sessionId, isError: false, structuredOutput, usage: { totalCostUsd: 0.5 } };
}

/** Returns a scripted result per session, recording how each session was started. */
class StubAgent implements CodingAgent {
  readonly name = "stub";
  readonly calls: CodingAgentSessionOptions[] = [];

  constructor(private readonly results: CodingAgentResult[]) {}

  startSession(options: CodingAgentSessionOptions): CodingAgentSession {
    this.calls.push(options);
    const result = this.results[this.calls.length - 1] ?? this.results.at(-1)!;
    return {
      async *events(): AsyncIterable<CodingAgentEvent> {
        yield { type: "result", result };
      },
      async result() {
        return result;
      },
      async cancel() {},
    };
  }
}

test("resolves a good citation out of the repository in one session", async () => {
  const agent = new StubAgent([resultWith(draftCiting(REAL_FILE))]);

  const outcome = await runAssessment({ agent, repositoryPath });

  assert.equal(agent.calls.length, 1);
  assert.equal(outcome.runInfo.repairRounds, 0);

  const finding = outcome.validation.assessment?.components
    .find((component) => component.category === "authentication_and_identity")
    ?.findings[0];
  // The snippet was never in the draft. It comes from the file.
  assert.equal(finding?.evidence[0]?.snippet, REAL_SNIPPET);
  assert.ok(finding?.evidence[0]?.evidenceId);
});

test("drops a bad citation without going back to the agent", async () => {
  const agent = new StubAgent([resultWith(draftCiting(HALLUCINATED_FILE))]);

  const outcome = await runAssessment({ agent, repositoryPath });

  assert.equal(agent.calls.length, 1, "a dropped citation is not worth a second session");
  assert.equal(outcome.runInfo.repairRounds, 0);
  assert.equal(outcome.validation.droppedEvidence.length, 1);
  assert.equal(outcome.validation.droppedEvidence[0]?.reason, "file_missing");
  // The nearest real file is recorded, for whoever reads the report.
  assert.equal(outcome.validation.droppedEvidence[0]?.suggestion, REAL_FILE);
});

test("removes a finding whose every citation was dropped", async () => {
  const agent = new StubAgent([resultWith(draftCiting(HALLUCINATED_FILE))]);

  const outcome = await runAssessment({ agent, repositoryPath });

  assert.equal(outcome.validation.droppedFindings.length, 1);
  const category = outcome.validation.assessment?.components.find(
    (component) => component.category === "authentication_and_identity",
  );
  assert.equal(category?.findings.length, 0);
});

test("reports every component category and policy rule, answered or not", async () => {
  const agent = new StubAgent([resultWith(draftCiting(REAL_FILE))]);

  const outcome = await runAssessment({ agent, repositoryPath });
  const assessment = outcome.validation.assessment;

  assert.equal(assessment?.components.length, 10);
  assert.equal(assessment?.policyAlignment.length, 6);
  // The draft answered no policy rules, so all six come back unknown.
  assert.ok(assessment?.policyAlignment.every((entry) => entry.status === "unknown"));
});

test("retries once when the draft does not parse, and accepts the correction", async () => {
  const agent = new StubAgent([
    resultWith({ summary: "truncated" }),
    resultWith(draftCiting(REAL_FILE)),
  ]);

  const outcome = await runAssessment({ agent, repositoryPath });

  assert.equal(agent.calls.length, 2);
  assert.equal(outcome.runInfo.repairRounds, 1);
  assert.equal(agent.calls[1]?.resumeSessionId, "session-1");
  assert.match(agent.calls[1]?.instructions ?? "", /did not conform to the output schema/);
  assert.ok(outcome.validation.assessment);
});

test("does not retry when disabled", async () => {
  const agent = new StubAgent([resultWith({ summary: "truncated" })]);

  const outcome = await runAssessment({ agent, repositoryPath, maxRetries: 0 });

  assert.equal(agent.calls.length, 1);
  assert.equal(outcome.validation.assessment, undefined);
  assert.ok(outcome.validation.errors.length > 0);
});

test("keeps the failure when a retry errors out", async () => {
  const agent = new StubAgent([
    resultWith({ summary: "truncated" }),
    { sessionId: "session-1", isError: true, stopReason: "crashed" },
  ]);

  const outcome = await runAssessment({ agent, repositoryPath });

  assert.equal(outcome.runInfo.repairRounds, 1);
  assert.equal(outcome.validation.assessment, undefined);
});

test("totals cost across the initial session and retries", async () => {
  const agent = new StubAgent([
    resultWith({ summary: "truncated" }),
    resultWith(draftCiting(REAL_FILE)),
  ]);

  const outcome = await runAssessment({ agent, repositoryPath });

  assert.equal(outcome.runInfo.usage?.totalCostUsd, 1);
});
