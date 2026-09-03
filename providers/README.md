# Provider reference directory

This directory holds structured facts about where common cloud and AI
providers store and process data, and how a repository typically indicates
which region is in use. It's the grounding Sovereignty Trace gives the
coding agent so it doesn't have to guess or hallucinate a provider's data
residency characteristics.

This material is not preloaded into an assessment session — the agent
retrieves specific records on demand, once it has identified a provider
worth grounding, via the ST knowledge interface
([`src/knowledge/`](../src/knowledge/), exposed to Claude Code as the
`st_search_providers` / `st_get_provider` tools). `st_get_provider` still
returns one text record per provider; the text is now rendered from the
structured entry rather than authored freehand — see Format below.

## What's here

Cloud and AI providers:

- [`aws.yaml`](./aws.yaml)
- [`microsoft-azure.yaml`](./microsoft-azure.yaml)
- [`azure-openai.yaml`](./azure-openai.yaml)
- [`google-cloud.yaml`](./google-cloud.yaml)
- [`anthropic-claude.yaml`](./anthropic-claude.yaml)
- [`openai.yaml`](./openai.yaml)

Vendor SaaS (email, messaging, monitoring, data, mapping):

- [`datadog.yaml`](./datadog.yaml)
- [`esri-arcgis.yaml`](./esri-arcgis.yaml)
- [`gc-notify.yaml`](./gc-notify.yaml)
- [`google-analytics.yaml`](./google-analytics.yaml)
- [`google-maps.yaml`](./google-maps.yaml)
- [`mapbox.yaml`](./mapbox.yaml)
- [`sendgrid.yaml`](./sendgrid.yaml)
- [`sentry.yaml`](./sentry.yaml)
- [`snowflake.yaml`](./snowflake.yaml)
- [`sonarqube-cloud.yaml`](./sonarqube-cloud.yaml)
- [`sysdig.yaml`](./sysdig.yaml)
- [`twilio.yaml`](./twilio.yaml)

## Organization-specific services

[`bcgov/`](./bcgov/) holds services specific to the BC Government — internal
platforms and shared government services that a generic public registry
would never carry (BC Express Pay, CHEFS, CHES, Common Notify, COMS, the
Private Cloud OpenShift platform, Pathfinder SSO, and others). The loader
recurses into subdirectories, so these load as ordinary provider records;
they're grouped separately only to keep them out of the general vendor
list. Their ids are prefixed `bcgov-` to keep that clear regardless of
which directory they load from. Copy the directory shape for another
organization's services.

Some of these entries do not expose a stable public domain or package
signature (BC Express Pay, Common Notify) — they're still useful as
grounding text and as templates, but won't be found by `st_search_providers`
unless the agent searches by name.

## Important caveats

- **Region configuration in code is the strongest signal; defaults are
  weaker.** A hardcoded `region: "ca-central-1"` is strong evidence. An SDK
  client with no region set at all usually falls back to a provider- or
  environment-specific default, which may not be Canadian — flag it as
  "region not pinned in code" rather than asserting a location.
- **These entries can go stale.** Providers add regions, change defaults,
  and change data-processing terms. An entry's `status` and
  `metadata.last_verified` say how recently its claims were checked — a
  missing `last_verified` means exactly that: nobody has recorded checking
  it, so treat it as unverified regardless of `status`. Note in the
  assessment when a claim depends on something that should be re-verified
  against the provider's current documentation.
- **A provider not listed here doesn't mean anything about its residency.**
  It means Sovereignty Trace doesn't have reference material for it yet.
  Say so explicitly in the finding rather than guessing.

## Format

Each entry is one YAML file, validated against
[`src/knowledge/provider-schema.ts`](../src/knowledge/provider-schema.ts)
and rendered to text by
[`src/knowledge/provider-render.ts`](../src/knowledge/provider-render.ts).
[`schema.yaml`](./schema.yaml) documents every field and is not itself
loaded as a provider (same treatment as this README).

The `id` field (which must match the filename, e.g. `aws` in `aws.yaml`) is
the id the agent uses to refer to this record. A provider is modeled as one
or more `access_paths` — almost always one, but a vendor reachable through
genuinely different backends with different residency characteristics
(Claude via Anthropic's own API vs. via Amazon Bedrock vs. via Google Vertex
AI) gets one path per backend within a single entry, so searching the
vendor's name surfaces every path at once instead of splitting them into
unrelated provider ids.

Absent means unknown throughout: don't fill in a region, an evidence URL, or
a `last_verified` date that hasn't actually been checked.
