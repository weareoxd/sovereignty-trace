import assert from "node:assert/strict";
import { test } from "node:test";
import type { ResidencyStatus } from "./residency.js";
import { rollUpRisk, scoreFinding } from "./risk.js";
import type { DataClassification, RiskLevel } from "./schema.js";

/**
 * One case per row of the scoring rule. These are the assertions that keep the
 * score reproducible, so a change here should be a deliberate policy decision
 * rather than a fix to make a run look better.
 */

function score(
  classification: DataClassification,
  residency: ResidencyStatus,
  activePath: boolean,
): RiskLevel {
  return scoreFinding({ classification, residency, activePath });
}

const PERSONAL: DataClassification[] = ["personal_information", "protected_b", "protected_c"];

test("Protected C outside Canada is high whether or not the path is active", () => {
  for (const residency of ["outside_canada", "unknown", "no_record"] as ResidencyStatus[]) {
    assert.equal(score("protected_c", residency, true), "high", residency);
    assert.equal(score("protected_c", residency, false), "high", `${residency} (alternate)`);
  }
});

test("personal information leaving Canada is high on the active path, medium on an alternate", () => {
  for (const classification of ["personal_information", "protected_b"] as DataClassification[]) {
    assert.equal(score(classification, "outside_canada", true), "high");
    assert.equal(score(classification, "outside_canada", false), "medium");
  }
});

test("unknown residency scores the same as leaving Canada", () => {
  // The case the old prose rubric had no answer for, and the common one: most
  // provider records state no storage residency at all.
  for (const classification of ["personal_information", "protected_b"] as DataClassification[]) {
    for (const residency of ["unknown", "no_record"] as ResidencyStatus[]) {
      assert.equal(score(classification, residency, true), "high", `${classification}/${residency}`);
      assert.equal(score(classification, residency, false), "medium", `${classification}/${residency}`);
    }
  }
});

test("personal information staying in Canada is low", () => {
  for (const classification of PERSONAL) {
    assert.equal(score(classification, "canada", true), "low");
    assert.equal(score(classification, "canada", false), "low");
  }
});

test("credentials leaving Canada are medium on the active path, low on an alternate", () => {
  for (const residency of ["outside_canada", "unknown", "no_record"] as ResidencyStatus[]) {
    assert.equal(score("credentials_or_secrets", residency, true), "medium", residency);
    assert.equal(score("credentials_or_secrets", residency, false), "low", residency);
  }
  assert.equal(score("credentials_or_secrets", "canada", true), "low");
});

test("operational data is medium only when it is known to leave Canada on the active path", () => {
  assert.equal(score("operational", "outside_canada", true), "medium");
  assert.equal(score("operational", "outside_canada", false), "low");
  assert.equal(score("operational", "unknown", true), "low");
  assert.equal(score("operational", "no_record", true), "low");
  assert.equal(score("operational", "canada", true), "low");
});

test("nothing sensitive is low regardless of destination", () => {
  for (const residency of ["canada", "outside_canada", "unknown", "no_record"] as ResidencyStatus[]) {
    assert.equal(score("none_identified", residency, true), "low", residency);
  }
});

test("unclassified reports as unknown rather than picking a tier", () => {
  for (const residency of ["canada", "outside_canada", "unknown", "no_record"] as ResidencyStatus[]) {
    assert.equal(score("unclassified", residency, true), "unknown", residency);
  }
});

test("a self-hosted component is low, because nothing left the deployment", () => {
  // The border question for the deployment itself belongs to its own
  // infrastructure finding, not to every component running inside it.
  for (const classification of PERSONAL) {
    assert.equal(score(classification, "self_hosted", true), "low", classification);
  }
});

test("overall risk is the highest level any finding reached", () => {
  assert.equal(rollUpRisk(["low", "medium", "high"]), "high");
  assert.equal(rollUpRisk(["low", "medium"]), "medium");
  assert.equal(rollUpRisk(["low", "low"]), "low");
});

test("one unclassifiable finding does not drag down a document with real findings", () => {
  assert.equal(rollUpRisk(["unknown", "high"]), "high");
  assert.equal(rollUpRisk(["unknown", "low"]), "low");
});

test("overall risk is unknown only when there is nothing else to go on", () => {
  assert.equal(rollUpRisk([]), "unknown");
  assert.equal(rollUpRisk(["unknown", "unknown"]), "unknown");
});
