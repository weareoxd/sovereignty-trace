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
  repositoryPath = await mkdtemp(join(tmpdir(), "st-run-"));
  const absolute = join(repositoryPath, REAL_FILE);
  await mkdir(dirname(absolute), { recursive: true });
  await writeFile(absolute, `${REAL_SNIPPET}\n  constructor() {}\n}\n`, "utf8");
});

after(async () => {
  await rm(repositoryPath, { recursive: true, force: true });
});

function draftCiting(file: string, findingOverrides: Record<string, unknown> = {}) {
  return {
    summary: "Test assessment.",
    components: [{ category: "authentication_and_identity", summary: "Auth via BC Gov SSO." }],
    findings: [
      {
        name: "Authentication via BC Government SSO (Keycloak)",
        description: "Validates Keycloak-issued JWTs.",
        category: "authentication_and_identity",
        providerId: "bcgov-sso",
        classification: "personal_information",
        activePath: true,
        evidence: [{ file, lines: "1" }],
        ...findingOverrides,
      },
    ],
    policyAlignment: [],
  };
}

function categoryOf(outcome: Awaited<ReturnType<typeof runAssessment>>, category: string) {
  return outcome.validation.assessment?.components.find(
    (component) => component.category === category,
  );
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

  const finding = categoryOf(outcome, "authentication_and_identity")?.findings[0];
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
  assert.equal(categoryOf(outcome, "authentication_and_identity")?.findings.length, 0);
});

test("a finding relevant to two categories is reported once and pointed at twice", async () => {
  // The BC Parks case: one OpenSearch cluster that is both a database and a
  // piece of infrastructure. It used to be two findings that disagreed about
  // how the data was classified, and so scored High in one place and Low in
  // the other.
  const agent = new StubAgent([
    resultWith(draftCiting(REAL_FILE, { category: "database", alsoRelevantTo: ["infrastructure"] })),
  ]);

  const outcome = await runAssessment({ agent, repositoryPath });

  const database = categoryOf(outcome, "database");
  const infrastructure = categoryOf(outcome, "infrastructure");

  assert.equal(database?.findings.length, 1, "reported in full under its own category");
  assert.equal(database?.alsoRelevantHere.length, 0);

  assert.equal(infrastructure?.findings.length, 0, "not a second copy under the other category");
  assert.equal(infrastructure?.alsoRelevantHere.length, 1);
  assert.equal(infrastructure?.alsoRelevantHere[0]?.category, "database", "points back to the full entry");

  // One finding, so one score — which is the whole point of the cross-reference.
  assert.equal(infrastructure?.alsoRelevantHere[0]?.riskLevel, database?.findings[0]?.riskLevel);
});

test("a finding is not cross-referenced into its own category", async () => {
  const agent = new StubAgent([
    resultWith(
      draftCiting(REAL_FILE, { category: "database", alsoRelevantTo: ["database", "infrastructure"] }),
    ),
  ]);

  const outcome = await runAssessment({ agent, repositoryPath });
  const database = categoryOf(outcome, "database");

  assert.equal(database?.findings.length, 1);
  assert.equal(database?.alsoRelevantHere.length, 0, "it would otherwise point at itself");
});

test("overall risk counts a multi-category finding once", async () => {
  const agent = new StubAgent([
    resultWith(
      draftCiting(REAL_FILE, {
        category: "database",
        alsoRelevantTo: ["infrastructure", "data_storage"],
        classification: "operational",
      }),
    ),
  ]);

  const outcome = await runAssessment({ agent, repositoryPath });
  const assessment = outcome.validation.assessment;

  const reported = assessment?.components.flatMap((component) => component.findings) ?? [];
  assert.equal(reported.length, 1);
  assert.equal(assessment?.overallRisk, reported[0]?.riskLevel);
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
