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
  repositoryPath = await mkdtemp(join(tmpdir(), "sg-repair-"));
  const absolute = join(repositoryPath, REAL_FILE);
  await mkdir(dirname(absolute), { recursive: true });
  await writeFile(absolute, `${REAL_SNIPPET}\n  constructor() {}\n}\n`, "utf8");
});

after(async () => {
  await rm(repositoryPath, { recursive: true, force: true });
});

function assessmentCiting(file: string) {
  return {
    schemaVersion: "1.0",
    summary: "Test assessment.",
    overallRisk: "low",
    components: [
      {
        category: "authentication_and_identity",
        summary: "Auth via BC Gov SSO.",
        findings: [
          {
            name: "Authentication via BC Government SSO (Keycloak)",
            description: "Validates Keycloak-issued JWTs.",
            riskLevel: "low",
            evidence: [{ file, lines: "1", snippet: REAL_SNIPPET }],
          },
        ],
      },
    ],
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

test("hands a bad citation back to the same session and accepts the correction", async () => {
  const agent = new StubAgent([
    resultWith(assessmentCiting(HALLUCINATED_FILE)),
    resultWith(assessmentCiting(REAL_FILE)),
  ]);

  const outcome = await runAssessment({ agent, repositoryPath });

  assert.equal(outcome.validation.valid, true);
  assert.equal(outcome.runInfo.repairRounds, 1);
  assert.equal(agent.calls.length, 2);
  assert.equal(agent.calls[1]?.resumeSessionId, "session-1");
  assert.match(agent.calls[1]?.instructions ?? "", /Citations to fix/);
  assert.match(agent.calls[1]?.instructions ?? "", new RegExp(HALLUCINATED_FILE));
  // The suggester's answer is offered to the agent as a hint to verify.
  assert.match(agent.calls[1]?.instructions ?? "", new RegExp(REAL_FILE));
});

test("stops after the configured number of repair rounds", async () => {
  const agent = new StubAgent([resultWith(assessmentCiting(HALLUCINATED_FILE))]);

  const outcome = await runAssessment({ agent, repositoryPath, maxRepairRounds: 2 });

  assert.equal(outcome.validation.valid, false);
  assert.equal(outcome.runInfo.repairRounds, 2);
  assert.equal(agent.calls.length, 3);
});

test("does not attempt repair when disabled", async () => {
  const agent = new StubAgent([resultWith(assessmentCiting(HALLUCINATED_FILE))]);

  const outcome = await runAssessment({ agent, repositoryPath, maxRepairRounds: 0 });

  assert.equal(outcome.runInfo.repairRounds, 0);
  assert.equal(agent.calls.length, 1);
  assert.equal(outcome.validation.taintedFindings.length, 1);
});

test("does not run a repair round when the first result already verifies", async () => {
  const agent = new StubAgent([resultWith(assessmentCiting(REAL_FILE))]);

  const outcome = await runAssessment({ agent, repositoryPath });

  assert.equal(outcome.validation.valid, true);
  assert.equal(outcome.runInfo.repairRounds, 0);
  assert.equal(agent.calls.length, 1);
});

test("keeps the original assessment when a repair round errors out", async () => {
  const agent = new StubAgent([
    resultWith(assessmentCiting(HALLUCINATED_FILE)),
    { sessionId: "session-1", isError: true, stopReason: "crashed" },
  ]);

  const outcome = await runAssessment({ agent, repositoryPath });

  assert.equal(outcome.runInfo.repairRounds, 1);
  assert.ok(outcome.validation.assessment, "the first assessment should survive a failed repair");
  assert.equal(outcome.validation.taintedFindings.length, 1);
});

test("keeps the original assessment when a repair round returns invalid output", async () => {
  const agent = new StubAgent([
    resultWith(assessmentCiting(HALLUCINATED_FILE)),
    resultWith({ schemaVersion: "1.0", summary: "truncated" }),
  ]);

  const outcome = await runAssessment({ agent, repositoryPath });

  assert.ok(outcome.validation.assessment);
  assert.equal(outcome.validation.assessment?.components.length, 1);
});

test("totals cost across the initial session and repair rounds", async () => {
  const agent = new StubAgent([
    resultWith(assessmentCiting(HALLUCINATED_FILE)),
    resultWith(assessmentCiting(REAL_FILE)),
  ]);

  const outcome = await runAssessment({ agent, repositoryPath });

  assert.equal(outcome.runInfo.usage?.totalCostUsd, 1);
});
