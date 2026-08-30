import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, test } from "node:test";
import { validateAssessment, unverifiedEvidence, type Evidence } from "./index.js";

/**
 * A miniature stand-in for the repository shape that produced the original
 * failure: two similarly named auth files in different directories, which is
 * what the agent blended into a path that never existed.
 */
const FIXTURE_FILES: Record<string, string> = {
  "backend/src/auth/auth.jwt-strategy.ts": [
    "import { Injectable } from '@nestjs/common';",
    "import { PassportStrategy } from '@nestjs/passport';",
    "",
    "@Injectable()",
    "export class JwtStrategy extends PassportStrategy(Strategy) {",
    "  constructor() {",
    "    super({ issuer: process.env.KEYCLOAK_ISSUER });",
    "  }",
    "}",
  ].join("\n"),
  "backend/src/auth/auth.jwt-guard.ts": "export class JwtGuard {}\n",
  "backend/src/app.module.ts": "export class AppModule {}\n",
};

let repositoryPath: string;
const files = Object.keys(FIXTURE_FILES);

before(async () => {
  repositoryPath = await mkdtemp(join(tmpdir(), "sg-validation-"));
  for (const [relative, contents] of Object.entries(FIXTURE_FILES)) {
    const absolute = join(repositoryPath, relative);
    await mkdir(dirname(absolute), { recursive: true });
    await writeFile(absolute, contents, "utf8");
  }
});

after(async () => {
  await rm(repositoryPath, { recursive: true, force: true });
});

/** Wraps evidence in the smallest assessment the schema will accept. */
function assessmentWith(evidence: Evidence[]) {
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
            description: "The backend validates JWTs issued by Keycloak.",
            riskLevel: "low",
            evidence,
          },
        ],
      },
    ],
  };
}

function validate(evidence: Evidence[]) {
  return validateAssessment(assessmentWith(evidence), { repositoryPath, files });
}

const REAL_EVIDENCE: Evidence = {
  file: "backend/src/auth/auth.jwt-strategy.ts",
  lines: "5-8",
  snippet: "export class JwtStrategy extends PassportStrategy(Strategy) {",
};

test("accepts a citation whose file and snippet both check out", async () => {
  const result = await validate([REAL_EVIDENCE]);

  assert.equal(result.valid, true);
  assert.deepEqual(result.taintedFindings, []);
  assert.equal(result.evidenceChecks.length, 1);
  assert.equal(result.evidenceChecks[0]?.verdict, "verified");
});

test("flags the hallucinated path from the common-notify run and suggests the real file", async () => {
  const result = await validate([
    { ...REAL_EVIDENCE, file: "backend/src/common/guards/auth.jwt-strategy.ts" },
  ]);

  const [check] = unverifiedEvidence(result);
  assert.equal(check?.verdict, "file_missing");
  assert.equal(check?.suggestion, "backend/src/auth/auth.jwt-strategy.ts");
  assert.equal(check?.path, "components[0].findings[0].evidence[0]");
});

test("catches a fabricated snippet pinned to a file that really exists", async () => {
  const result = await validate([
    { ...REAL_EVIDENCE, snippet: "const s3 = new S3Client({ region: 'us-east-1' });" },
  ]);

  const [check] = unverifiedEvidence(result);
  assert.equal(check?.verdict, "snippet_mismatch");
  assert.equal(result.valid, false);
});

test("tolerates whitespace and indentation differences in a real snippet", async () => {
  const result = await validate([
    {
      ...REAL_EVIDENCE,
      snippet: "      super({   issuer: process.env.KEYCLOAK_ISSUER });\n\n",
    },
  ]);

  assert.equal(result.evidenceChecks[0]?.verdict, "verified");
});

test("rejects a citation with no snippet", async () => {
  const result = await validate([{ ...REAL_EVIDENCE, snippet: "   " }]);

  assert.equal(unverifiedEvidence(result)[0]?.verdict, "snippet_mismatch");
});

test("flags a line range past the end of the file", async () => {
  const result = await validate([{ ...REAL_EVIDENCE, lines: "400-420" }]);

  const [check] = unverifiedEvidence(result);
  assert.equal(check?.verdict, "lines_out_of_range");
  assert.match(check?.message ?? "", /9 line\(s\)/);
});

test("flags an absolute path and points at its repository-relative form", async () => {
  const result = await validate([
    { ...REAL_EVIDENCE, file: join(repositoryPath, "backend/src/auth/auth.jwt-strategy.ts") },
  ]);

  const [check] = unverifiedEvidence(result);
  assert.equal(check?.verdict, "absolute_path");
  assert.equal(check?.suggestion, "backend/src/auth/auth.jwt-strategy.ts");
});

test("flags a path that escapes the repository", async () => {
  const result = await validate([{ ...REAL_EVIDENCE, file: "../../etc/passwd" }]);

  assert.equal(unverifiedEvidence(result)[0]?.verdict, "outside_repository");
});

test("flags a directory cited as evidence", async () => {
  const result = await validate([{ ...REAL_EVIDENCE, file: "backend/src/auth" }]);

  assert.equal(unverifiedEvidence(result)[0]?.verdict, "unreadable");
});

test("taints only the offending finding and counts its surviving evidence", async () => {
  const result = await validate([
    REAL_EVIDENCE,
    { ...REAL_EVIDENCE, file: "backend/src/common/guards/auth.jwt-strategy.ts" },
  ]);

  assert.equal(result.valid, false);
  assert.equal(result.taintedFindings.length, 1);

  const [taint] = result.taintedFindings;
  assert.equal(taint?.path, "components[0].findings[0]");
  assert.equal(taint?.label, "Authentication via BC Government SSO (Keycloak)");
  assert.equal(taint?.verified, 1);
  assert.equal(taint?.total, 2);
  assert.equal(taint?.failures.length, 1);
});

test("keeps evidence problems out of the global errors list", async () => {
  const result = await validate([{ ...REAL_EVIDENCE, file: "nope/missing.ts" }]);

  assert.deepEqual(result.errors, []);
  assert.equal(result.valid, false);
  assert.equal(result.taintedFindings.length, 1);
});

test("reports a schema violation as a structural error, not as taint", async () => {
  const result = await validateAssessment(
    { schemaVersion: "1.0", summary: "x" },
    { repositoryPath, files },
  );

  assert.equal(result.valid, false);
  assert.ok(result.errors.length > 0);
  assert.equal(result.assessment, undefined);
  assert.deepEqual(result.evidenceChecks, []);
});
