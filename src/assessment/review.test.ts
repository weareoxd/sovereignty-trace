import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, test } from "node:test";
import { reviewAssessmentOutput } from "./review.js";

const REAL_FILE = "backend/src/auth/auth.jwt-strategy.ts";
const REAL_SNIPPET = "export class JwtStrategy extends PassportStrategy(Strategy) {";

let repositoryPath: string;

before(async () => {
  repositoryPath = await mkdtemp(join(tmpdir(), "sg-review-"));
  const absolute = join(repositoryPath, REAL_FILE);
  await mkdir(dirname(absolute), { recursive: true });
  await writeFile(absolute, `${REAL_SNIPPET}\n  constructor() {}\n}\n`, "utf8");
});

after(async () => {
  await rm(repositoryPath, { recursive: true, force: true });
});

function assessment(overrides: Record<string, unknown> = {}) {
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
            name: "Keycloak JWT validation",
            description: "Validates Keycloak-issued JWTs.",
            riskLevel: "low",
            evidence: [{ file: REAL_FILE, lines: "1", snippet: REAL_SNIPPET }],
            ...overrides,
          },
        ],
      },
    ],
  };
}

test("accepts a well-formed assessment", async () => {
  const verdict = await reviewAssessmentOutput(assessment(), {
    repositoryPath,
    requireVerifiedEvidence: true,
  });

  assert.equal(verdict.accepted, true);
});

test("rejects null where the schema wants an omitted optional field", async () => {
  // The exact failure from the swival run: null instead of an absent field.
  const verdict = await reviewAssessmentOutput(
    assessment({ provider: null, destinationJurisdiction: null }),
    { repositoryPath },
  );

  assert.equal(verdict.accepted, false);
  assert.match(verdict.feedback, /provider/);
  assert.match(verdict.feedback, /Do not set it to null/);
});

test("names every schema problem so one round can fix them all", async () => {
  const verdict = await reviewAssessmentOutput(
    assessment({ provider: null, riskLevel: "catastrophic" }),
    { repositoryPath },
  );

  assert.match(verdict.feedback, /provider/);
  assert.match(verdict.feedback, /riskLevel/);
});

test("rejects a document that is not an assessment at all", async () => {
  const verdict = await reviewAssessmentOutput({ hello: "world" }, { repositoryPath });

  assert.equal(verdict.accepted, false);
  assert.match(verdict.feedback, /does not conform to the required JSON schema/);
});

test("rejects a hallucinated citation and points at the real file", async () => {
  const verdict = await reviewAssessmentOutput(
    assessment({
      evidence: [
        {
          file: "backend/src/common/guards/auth.jwt-strategy.ts",
          lines: "1",
          snippet: REAL_SNIPPET,
        },
      ],
    }),
    { repositoryPath, requireVerifiedEvidence: true },
  );

  assert.equal(verdict.accepted, false);
  assert.match(verdict.feedback, /does not exist in the repository/);
  assert.match(verdict.feedback, new RegExp(REAL_FILE));
});

test("rejects a fabricated snippet on a real file", async () => {
  const verdict = await reviewAssessmentOutput(
    assessment({
      evidence: [{ file: REAL_FILE, lines: "1", snippet: "new S3Client({ region: 'us-east-1' })" }],
    }),
    { repositoryPath, requireVerifiedEvidence: true },
  );

  assert.equal(verdict.accepted, false);
  assert.match(verdict.feedback, /snippet does not appear/);
});

test("passes evidence problems only when evidence checking is on", async () => {
  const bad = assessment({
    evidence: [{ file: "nope/missing.ts", lines: "1", snippet: "whatever" }],
  });

  assert.equal((await reviewAssessmentOutput(bad, { repositoryPath })).accepted, true);
  assert.equal(
    (await reviewAssessmentOutput(bad, { repositoryPath, requireVerifiedEvidence: true })).accepted,
    false,
  );
});
