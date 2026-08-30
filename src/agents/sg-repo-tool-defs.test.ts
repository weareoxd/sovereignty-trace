import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, test } from "node:test";
import { validateAssessment } from "../assessment/validation.js";
import { createRepositoryToolDefs } from "./sg-repo-tool-defs.js";
import type { SgToolDef, SgToolResult } from "./sg-tool-defs.js";

const REAL_FILE = "backend/src/auth/auth.jwt-strategy.ts";
const LINES = [
  "import { Injectable } from '@nestjs/common';",
  "",
  "@Injectable()",
  "export class JwtStrategy extends PassportStrategy(Strategy) {",
  "  constructor() {",
  "    super({ issuer: process.env.KEYCLOAK_ISSUER });",
  "  }",
  "}",
];

let repositoryPath: string;
let citeEvidence: SgToolDef;

before(async () => {
  repositoryPath = await mkdtemp(join(tmpdir(), "sg-cite-"));
  const absolute = join(repositoryPath, REAL_FILE);
  await mkdir(dirname(absolute), { recursive: true });
  await writeFile(absolute, LINES.join("\n"), "utf8");

  const defs = createRepositoryToolDefs({ repositoryPath, files: [REAL_FILE] });
  citeEvidence = defs.find((def) => def.name === "sg_cite_evidence")!;
});

after(async () => {
  await rm(repositoryPath, { recursive: true, force: true });
});

function payload(result: SgToolResult): Record<string, string> {
  return JSON.parse(result.content[0]!.text);
}

async function cite(file: string, lines: string): Promise<SgToolResult> {
  return citeEvidence.handler({ file, lines });
}

test("returns the real text at the cited range with a handle", async () => {
  const result = await cite(REAL_FILE, "4-6");

  assert.notEqual(result.isError, true);
  const evidence = payload(result);
  assert.equal(evidence.file, REAL_FILE);
  assert.equal(evidence.lines, "4-6");
  assert.equal(evidence.snippet, LINES.slice(3, 6).join("\n"));
  assert.match(evidence.evidenceId!, /^ev_[0-9a-f]{16}$/);
});

test("clamps a range that runs past the end of the file", async () => {
  const evidence = payload(await cite(REAL_FILE, "6-999"));

  assert.equal(evidence.lines, "6-8");
  assert.equal(evidence.snippet, LINES.slice(5, 8).join("\n"));
});

test("refuses a path that does not exist and names the closest match", async () => {
  const result = await cite("backend/src/common/guards/auth.jwt-strategy.ts", "4");

  assert.equal(result.isError, true);
  assert.match(result.content[0]!.text, /Did you mean "backend\/src\/auth\/auth\.jwt-strategy\.ts"\?/);
});

test("refuses an absolute path", async () => {
  const result = await cite(join(repositoryPath, REAL_FILE), "4");

  assert.equal(result.isError, true);
  assert.match(result.content[0]!.text, /absolute path/);
});

test("refuses a path outside the repository", async () => {
  const result = await cite("../../etc/passwd", "1");

  assert.equal(result.isError, true);
  assert.match(result.content[0]!.text, /outside the repository/);
});

test("refuses a range starting past the end of the file", async () => {
  const result = await cite(REAL_FILE, "400");

  assert.equal(result.isError, true);
  assert.match(result.content[0]!.text, /past the end of the file/);
});

test("refuses an unparseable range", async () => {
  const result = await cite(REAL_FILE, "somewhere near the top");

  assert.equal(result.isError, true);
  assert.match(result.content[0]!.text, /line number or range/);
});

/** Builds the assessment a well-behaved agent would produce from tool output. */
function assessmentFrom(evidence: Record<string, string>) {
  return {
    schemaVersion: "1.0",
    summary: "Test assessment.",
    overallRisk: "low",
    components: [
      {
        category: "authentication_and_identity",
        summary: "Auth via Keycloak.",
        findings: [
          {
            name: "Keycloak JWT validation",
            description: "Validates Keycloak-issued JWTs.",
            riskLevel: "low",
            evidence: [evidence],
          },
        ],
      },
    ],
  };
}

test("a citation copied from the tool validates end to end", async () => {
  const evidence = payload(await cite(REAL_FILE, "4-6"));

  const result = await validateAssessment(assessmentFrom(evidence), {
    repositoryPath,
    files: [REAL_FILE],
  });

  assert.equal(result.valid, true);
  assert.equal(result.evidenceChecks[0]?.verdict, "verified");
});

test("a handle that does not match the cited range is rejected", async () => {
  const evidence = payload(await cite(REAL_FILE, "4-6"));

  const result = await validateAssessment(
    assessmentFrom({ ...evidence, evidenceId: "ev_0000000000000000" }),
    { repositoryPath, files: [REAL_FILE] },
  );

  assert.equal(result.evidenceChecks[0]?.verdict, "handle_mismatch");
});

test("a handle minted for a different range does not transfer", async () => {
  const first = payload(await cite(REAL_FILE, "4-6"));
  const second = payload(await cite(REAL_FILE, "1-2"));

  const result = await validateAssessment(
    assessmentFrom({ ...second, evidenceId: first.evidenceId! }),
    { repositoryPath, files: [REAL_FILE] },
  );

  assert.equal(result.evidenceChecks[0]?.verdict, "handle_mismatch");
});
