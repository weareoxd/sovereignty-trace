import assert from "node:assert/strict";
import { test } from "node:test";
import { reviewAssessmentOutput } from "./review.js";

/**
 * The in-session accept/retry gate. It checks the draft's shape only —
 * citations are resolved against the repository downstream, so there is no
 * evidence to check here any more.
 */

function draft(findingOverrides: Record<string, unknown> = {}, top: Record<string, unknown> = {}) {
  return {
    summary: "Test assessment.",
    components: [{ category: "authentication_and_identity", summary: "Auth via BC Gov SSO." }],
    findings: [
      {
        name: "Keycloak JWT validation",
        description: "Validates Keycloak-issued JWTs.",
        category: "authentication_and_identity",
        providerId: "bcgov-sso",
        classification: "personal_information",
        activePath: true,
        evidence: [{ file: "backend/src/auth/auth.jwt-strategy.ts", lines: "1" }],
        ...findingOverrides,
      },
    ],
    policyAlignment: [
      {
        ruleId: "personal-information-outside-canada",
        status: "aligned",
        explanation: "Identity data stays in Canada.",
      },
    ],
    ...top,
  };
}

test("accepts a well-formed draft", async () => {
  const verdict = await reviewAssessmentOutput(draft());
  assert.equal(verdict.accepted, true, verdict.feedback);
});

test("rejects null where the schema wants an omitted optional field", async () => {
  // The exact failure from the swival run: null instead of an absent field.
  const verdict = await reviewAssessmentOutput(draft({ notes: null }));

  assert.equal(verdict.accepted, false);
  assert.match(verdict.feedback, /notes/);
  assert.match(verdict.feedback, /Do not set it to null/);
});

test("names every schema problem so one round can fix them all", async () => {
  const verdict = await reviewAssessmentOutput(
    draft({ notes: null, classification: "catastrophic" }),
  );

  assert.match(verdict.feedback, /notes/);
  assert.match(verdict.feedback, /classification/);
});

test("rejects a document that is not an assessment at all", async () => {
  const verdict = await reviewAssessmentOutput({ hello: "world" });

  assert.equal(verdict.accepted, false);
  assert.match(verdict.feedback, /does not conform to the required JSON schema/);
});

test("rejects a provider id that is not a record, while the agent can still fix it", async () => {
  // "ches" is the id past runs invented; the record is "bcgov-ches". The enum
  // is what turns that from a silent miss into a correction.
  const verdict = await reviewAssessmentOutput(draft({ providerId: "ches" }));

  assert.equal(verdict.accepted, false);
  assert.match(verdict.feedback, /providerId/);
});

test("accepts the two provider ids that are not records", async () => {
  for (const providerId of ["no_matching_record", "self_hosted_or_no_third_party"]) {
    const verdict = await reviewAssessmentOutput(draft({ providerId }));
    assert.equal(verdict.accepted, true, `${providerId}: ${verdict.feedback}`);
  }
});

test("rejects a category that is not a component category", async () => {
  const verdict = await reviewAssessmentOutput(draft({ category: "search_cluster" }));

  assert.equal(verdict.accepted, false);
  assert.match(verdict.feedback, /category/);
});

test("accepts a finding that names other categories it is relevant to", async () => {
  const verdict = await reviewAssessmentOutput(
    draft({ category: "database", alsoRelevantTo: ["infrastructure"] }),
  );

  assert.equal(verdict.accepted, true, verdict.feedback);
});

test("rejects a policy rule id that does not exist", async () => {
  const verdict = await reviewAssessmentOutput(
    draft({}, { policyAlignment: [{ ruleId: "made-up-rule", status: "aligned", explanation: "x" }] }),
  );

  assert.equal(verdict.accepted, false);
  assert.match(verdict.feedback, /ruleId/);
});
