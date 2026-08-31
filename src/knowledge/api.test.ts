import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildPolicyBrief,
  buildProviderIndex,
  getProviderEntry,
  listPolicyRules,
  listProviderIds,
} from "./index.js";

/**
 * The provider enum and the provider index are both generated from the records
 * on disk. These check they stay in step with what is actually there, and that
 * the index carries enough to identify a record.
 */

test("the provider id list covers every record and excludes the schema template", async () => {
  const ids = await listProviderIds();

  assert.ok(ids.length >= 25, `expected the registry to be populated, got ${ids.length}`);
  assert.ok(!ids.includes("provider-id"), "providers/schema.yaml is a template, not a record");
  assert.ok(ids.includes("twilio"));
  assert.ok(ids.includes("bcgov-ches"), "records in providers/bcgov/ load like any other");
  assert.deepEqual(ids, [...ids].sort(), "ids are sorted, so the enum is stable between runs");
});

test("`ches` is not an id; `bcgov-ches` is", async () => {
  // The miss that started this: a plausible slug guessed against an
  // exact-match lookup. The enum is what turns it into a visible choice.
  const ids = await listProviderIds();
  assert.ok(!ids.includes("ches"));
  assert.ok(ids.includes("bcgov-ches"));
});

test("the index has one line per record", async () => {
  const [index, ids] = await Promise.all([buildProviderIndex(), listProviderIds()]);
  assert.equal(index.split("\n").length, ids.length);
});

test("the index carries what id and name alone leave out", async () => {
  const index = await buildProviderIndex();
  const line = (id: string) => index.split("\n").find((l) => l.startsWith(`${id} |`)) ?? "";

  // Neither term appears in the record's name, only in its description. An
  // index of ids and names would give the agent no way to match either one.
  assert.match(line("bcgov-sso"), /Keycloak/i);
  assert.match(line("bcgov-coms"), /S3-compatible/i);

  // Signature values are what a repository actually shows.
  assert.match(line("twilio"), /api\.twilio\.com/);
});

test("the index carries the signals the unstable subjects were missed on", async () => {
  // Each of these is a provider pick that flipped between runs against the same
  // commit. In every case the repository showed something the index did not
  // carry, so the model had nothing to match on and guessed differently
  // each time.
  const index = await buildProviderIndex();
  const line = (id: string) => index.split("\n").find((l) => l.startsWith(`${id} |`)) ?? "";

  // Picked as `aws` once and `no_matching_record` twice. The repository
  // configures an S3 client against a government endpoint; only the AWS SDK
  // package name was matchable before.
  assert.match(line("bcgov-coms"), /commonservices\.objectstore\.gov\.bc\.ca/);
  assert.match(line("bcgov-coms"), /ObjectScale/i);

  // Picked as `bcgov-sso` twice by borrowing Pathfinder's identity.
  assert.match(line("bcgov-cstar"), /CSTAR_API_URL/);
  assert.match(line("bcgov-cstar"), /distinct service from BC Government SSO/i);

  // Always `no_matching_record`; the repository publishes through gwa.
  assert.match(line("bcgov-api-gateway"), /gwa/i);

  // Missed once because the repository sets CHES only through env vars and
  // never writes the hostname.
  assert.match(line("bcgov-ches"), /CHES_BASE_URL/);
});

test("the aws line warns off a custom endpoint", async () => {
  // A run identified a BC Government object store as Amazon because the
  // repository imports @aws-sdk/client-s3. The SDK is Amazon's; the
  // destination was not.
  const index = await buildProviderIndex();
  const line = index.split("\n").find((l) => l.startsWith("aws |")) ?? "";

  assert.match(line, /custom endpoint/i);
  assert.match(line, /S3-compatible/i);
});

test("the api gateway record does not claim every api.gov.bc.ca host", async () => {
  // CHES, CDOGS and the geocoder are published on the same domain and have
  // their own records. A bare *.api.gov.bc.ca signal on the gateway would
  // swallow all three.
  const entry = await getProviderEntry("bcgov-api-gateway");
  const domains = entry?.access_paths[0]?.signatures?.domains ?? [];

  assert.ok(domains.length > 0);
  assert.ok(
    !domains.includes("*.api.gov.bc.ca"),
    "a bare wildcard would collide with the named common services on this domain",
  );
  for (const domain of domains) {
    assert.ok(
      domain.startsWith("gw-") || domain.includes("/manager"),
      `${domain} is broad enough to match another record's service`,
    );
  }
});

test("cstar residency is derived from the platform, and says so", async () => {
  // The claim is Canada, but it comes from the OpenShift route the service
  // answers on rather than from CSTAR's own documentation. The reason field
  // has to carry that, otherwise the record reads as a stronger source than
  // it is.
  const entry = await getProviderEntry("bcgov-cstar");
  const storage = entry?.access_paths[0]?.data_residency.storage_regions;

  assert.equal(storage?.status, "known");
  assert.deepEqual(storage?.status === "known" ? storage.values : [], ["Canada"]);
  assert.match(
    storage?.status === "known" ? (storage.reason ?? "") : "",
    /deployment location|OpenShift/i,
  );
  assert.ok(entry?.access_paths[0]?.related_providers?.includes("bcgov-openshift"));
});

test("the object store record does not turn a protocol region into a residency claim", async () => {
  // ca-central-1 appears in the repository's S3 config, but it is a value the
  // client sends to satisfy the S3 API, not evidence about where the
  // government operates the store. The record must stay unknown so the score
  // fails loud rather than reading as Canadian.
  const entry = await getProviderEntry("bcgov-coms");

  for (const path of entry?.access_paths ?? []) {
    assert.equal(
      path.data_residency.storage_regions?.status,
      "unknown",
      `${path.key} asserts storage residency this registry cannot source`,
    );
  }
});

test("the index does not carry residency", async () => {
  // Residency is read off the record after the agent names it. Showing it here
  // would invite the agent to restate it from memory.
  const index = await buildProviderIndex();
  assert.ok(!/storage_regions|processing_regions/.test(index));
});

test("the parsed entry is available, not just the rendered prose", async () => {
  const entry = await getProviderEntry("bcgov-openshift");

  assert.equal(entry?.id, "bcgov-openshift");
  const storage = entry?.access_paths[0]?.data_residency.storage_regions;
  assert.equal(storage?.status, "known");
  assert.deepEqual(storage?.status === "known" ? storage.values : [], ["Canada"]);
});

test("every policy rule is listed with the document that holds it", async () => {
  const rules = await listPolicyRules();

  assert.equal(rules.length, 6);
  const ids = rules.map((rule) => rule.id);
  assert.ok(ids.includes("personal-information-outside-canada"));
  assert.ok(ids.includes("protected-c-in-public-cloud"));

  const foippa = rules.find((rule) => rule.id === "personal-information-outside-canada");
  assert.equal(foippa?.policyId, "bc-foippa-overview");
  assert.ok(foippa?.guidance.length > 0);
});

test("the policy brief carries the full text of both documents", async () => {
  const brief = await buildPolicyBrief();

  assert.match(brief, /FOIPPA/);
  assert.match(brief, /Protected C/);
  assert.ok(brief.length > 5000, "the whole set is inlined, not a summary");
});
