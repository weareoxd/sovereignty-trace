import assert from "node:assert/strict";
import { test } from "node:test";
import { NO_MATCHING_RECORD, resolveResidency, SELF_HOSTED } from "./residency.js";

/**
 * These run against the real registry in providers/, because the behaviour
 * being checked is the interaction between a record and a region an assessment
 * found — not the shape of either one on its own.
 */

test("a record with published regions ignores whatever region a finding reports", async () => {
  // bcgov-openshift publishes Canada. A region string cannot override a fact
  // the record already establishes, in either direction.
  const facts = await resolveResidency("bcgov-openshift", "us-east-1");

  assert.equal(facts.status, "canada");
  assert.equal(facts.crossesBorder, false);
});

test("a Canadian configured region resolves to Canada and names itself", async () => {
  const facts = await resolveResidency("aws", "ca-central-1");

  assert.equal(facts.status, "canada");
  assert.equal(facts.crossesBorder, false);
  assert.equal(facts.configuredRegion, "ca-central-1");
  assert.match(facts.destinationJurisdiction, /Canada/);
  assert.match(facts.destinationJurisdiction, /ca-central-1/);
});

test("a non-Canadian configured region resolves to outside Canada", async () => {
  const facts = await resolveResidency("aws", "us-east-1");

  assert.equal(facts.status, "outside_canada");
  assert.equal(facts.crossesBorder, true);
  assert.match(facts.destinationJurisdiction, /us-east-1/);
});

test("region matching ignores case and surrounding whitespace", async () => {
  for (const region of ["CA-CENTRAL-1", " ca-central-1 ", "Ca-Central-1"]) {
    assert.equal((await resolveResidency("aws", region)).status, "canada", region);
  }
});

test("each cloud's Canadian regions are read in that cloud's own spelling", async () => {
  assert.equal((await resolveResidency("aws", "ca-west-1")).status, "canada");
  assert.equal((await resolveResidency("microsoft-azure", "canadacentral")).status, "canada");
  assert.equal((await resolveResidency("google-cloud", "northamerica-northeast1")).status, "canada");

  // A region name belonging to a different provider is not a Canadian region here.
  assert.equal((await resolveResidency("microsoft-azure", "ca-central-1")).status, "outside_canada");
});

test("a record that does not derive its region from repositories stays unknown", async () => {
  // bcgov-coms sets configured_region_derivable_from_repository: false because
  // the ca-central-1 in its S3 config is a value the client sends to satisfy
  // the S3 API, not evidence about where the government operates the store.
  const facts = await resolveResidency("bcgov-coms", "ca-central-1");

  assert.equal(facts.status, "unknown");
  assert.equal(facts.crossesBorder, undefined);
});

test("a region the record cannot place is reported but does not score", async () => {
  // sysdig derives its region from repositories but lists no Canadian regions,
  // so there is nothing to compare against. The region still reaches the
  // report; the residency stays unknown rather than being guessed.
  const facts = await resolveResidency("sysdig", "us-east-1");

  assert.equal(facts.status, "unknown");
  assert.equal(facts.configuredRegion, "us-east-1");
  assert.match(facts.destinationJurisdiction, /us-east-1/);
});

test("no region reported keeps the original unknown wording", async () => {
  const facts = await resolveResidency("aws");

  assert.equal(facts.status, "unknown");
  assert.equal(facts.configuredRegion, undefined);
  assert.equal(facts.destinationJurisdiction, "unknown (record states no residency)");
});

test("an empty or whitespace region is treated as no region at all", async () => {
  for (const region of ["", "   "]) {
    const facts = await resolveResidency("aws", region);
    assert.equal(facts.status, "unknown", JSON.stringify(region));
    assert.equal(facts.destinationJurisdiction, "unknown (record states no residency)");
  }
});

test("the sentinels are unaffected by a region", async () => {
  assert.equal((await resolveResidency(SELF_HOSTED, "us-east-1")).status, "self_hosted");
  assert.equal((await resolveResidency(NO_MATCHING_RECORD, "ca-central-1")).status, "no_record");
});
