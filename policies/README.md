# Policy reference directory

This directory holds the policy and regulatory reference material Sovereignty
Graph gives to the coding agent as grounding for its `policyAlignment`
findings. It currently covers BC Government data-residency expectations,
since that's the initial use case this project was built for.

This material is not preloaded into an assessment session — the agent
retrieves specific records on demand, once repository evidence raises a
relevant sovereignty/privacy question, via the SG knowledge interface
([`src/knowledge/`](../src/knowledge/), exposed to Claude Code as the
`sg_search_policies` / `sg_get_policy` tools). `sg_get_policy` still returns
one text record per policy; the text is now rendered from the structured
entry rather than authored freehand — see Format below.

## What's here

- [`bc-foippa-overview.yaml`](./bc-foippa-overview.yaml) — the Freedom of
  Information and Protection of Privacy Act's storage/access-location rules
  for personal information held by public bodies.
- [`bc-cloud-and-security-policy.yaml`](./bc-cloud-and-security-policy.yaml)
  — BC Government core policy and OCIO direction on cloud use, information
  security, and privacy risk assessment.

## Important caveats

- **This is a starting reference, not a legal source.** These documents
  summarize publicly available policy in plain language for the purpose of
  giving a coding agent something concrete to check findings against. They
  are not a substitute for the actual legislation, core policy manual, or
  OCIO/CPO guidance, and may drift out of date. A citable section's
  `authority.checked` date says how recently its citation was confirmed —
  a missing `checked` means exactly that: nobody has recorded checking it,
  so treat it as unverified regardless of the document's `status`. Verify
  anything consequential against the authoritative source before acting on
  it.
- **Sovereignty Graph does not interpret law.** The agent's `policyAlignment`
  output records "does the evidence in this repository line up with what
  this document says", not a legal or compliance determination.
- Add a new file here for another jurisdiction's policy framework the same
  way: one YAML document per framework, written for an LLM to read as
  context, with an id you're comfortable citing in `policyReference.id`.

## Format

Each entry is one YAML file, validated against
[`src/knowledge/policy-schema.ts`](../src/knowledge/policy-schema.ts) and
rendered to text by
[`src/knowledge/policy-render.ts`](../src/knowledge/policy-render.ts).
[`schema.yaml`](./schema.yaml) documents every field and is not itself
loaded as a policy record (same treatment as this README).

The `id` field (which must match the filename, e.g. `bc-foippa-overview` in
`bc-foippa-overview.yaml`) is the id the agent uses when citing the document
in a `policyAlignment` finding's `policyReference.id` field. A document is
modeled as background `sections` (prose, not individually citable) plus one
or more `citable_sections` — each with a stable `id` used in
`policyReference.section`, and an optional `authority` block recording what
the section cites and when that citation was last checked. Where the old
freehand Markdown gave a "Findings this document supports" list with anchors
like `bc-foippa-overview#some-section`, that's now
`citable_sections[].id: "some-section"` directly.

Absent means unknown throughout: don't fill in an `authority.checked` date,
or a `metadata.last_reviewed` date, that hasn't actually been checked.
