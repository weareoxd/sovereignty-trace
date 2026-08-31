import { z } from "zod";

/**
 * Structured shape for a provider entry (providers/*.yaml). This is the
 * source of truth an entry's author fills in; src/knowledge/provider-render.ts
 * turns a validated entry into the prose a person reads.
 *
 * `data_residency` is what the assessment's risk score is computed from (see
 * ../assessment/residency.ts, which reads storage_regions and
 * processing_regions off this and nothing else). An entry that leaves them
 * absent reports as unknown residency, which for personal data on an active
 * path scores High — so an unfilled field is a loud answer here, not a quiet one.
 *
 * Absent means unknown. Do not fill in a value, an evidence URL, or a
 * last_verified date that hasn't actually been checked — see
 * providers/schema.yaml for the authoring guidance this mirrors.
 */

const evidenceSchema = z.object({
  url: z.string(),
  checked: z.string(),
});

/**
 * A fact about where something happens, with a required reason whenever the
 * answer isn't a known, published list of locations. "not_applicable" is for
 * facts that don't make sense for this provider (e.g. support_access_regions
 * for a provider with no human support channel) — distinct from "unknown",
 * which means the fact exists but isn't published/knowable.
 */
const regionFactSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("known"),
    values: z.array(z.string()).min(1),
    reason: z.string().optional(),
    evidence: z.array(evidenceSchema).optional(),
  }),
  z.object({
    status: z.literal("unknown"),
    reason: z.string(),
    evidence: z.array(evidenceSchema).optional(),
  }),
  z.object({
    status: z.literal("not_applicable"),
    reason: z.string(),
  }),
]);

const signaturesSchema = z.object({
  domains: z.array(z.string()).optional(),
  packages: z
    .object({
      python: z.array(z.string()).optional(),
      javascript: z.array(z.string()).optional(),
    })
    .optional(),
  modules: z
    .object({
      python: z.array(z.string()).optional(),
      javascript: z.array(z.string()).optional(),
    })
    .optional(),
  env_vars: z.array(z.string()).optional(),
  terraform_providers: z.array(z.string()).optional(),
  terraform_resource_prefixes: z.array(z.string()).optional(),
});

const dataResidencySchema = z.object({
  customer_configurable: z.union([z.boolean(), z.literal("unknown")]),

  // Whether *this specific* deployment's region is something an assessment
  // can determine by reading the repository, distinct from whether the
  // provider's region model itself is known/published (storage_regions /
  // processing_regions below). Most customer-configurable providers (AWS,
  // Azure, GCP) belong here rather than in storage_regions/processing_regions,
  // since there is no fixed set of values to enumerate — the actual region is
  // whatever the repository configures.
  configured_region_derivable_from_repository: z.boolean(),
  configured_region_reason: z.string(),

  // Only for providers with a fixed, published set of possible locations
  // (regardless of what a specific repository configures) — e.g. a vendor
  // that offers a small enumerated list of residency options, or one that
  // publishes it does not offer any (status: unknown/not_applicable).
  storage_regions: regionFactSchema.optional(),
  processing_regions: regionFactSchema.optional(),
  support_access_regions: regionFactSchema.optional(),
  telemetry_processing_regions: regionFactSchema.optional(),
});

const accessPathSchema = z.object({
  // Stable slug within this provider entry, e.g. "direct_api", "bedrock".
  key: z.string(),
  // Human-readable name for this path, e.g. "Anthropic's own API".
  label: z.string(),
  signatures: signaturesSchema.optional(),
  data_residency: dataResidencySchema,
  // Prose specific to this access path only — branching nuance belongs here,
  // not in the shared top-level `notes`.
  notes: z.string().optional(),
  // Other provider ids in this registry whose region evidence applies to
  // this path (e.g. the "bedrock" path on the anthropic-claude entry points
  // at "aws") — avoids restating another provider's region model here.
  related_providers: z.array(z.string()).optional(),
  evidence: z.array(evidenceSchema).optional(),
});

const legalEntitySchema = z.object({
  name: z.string(),
  role: z.enum(["contracting_entity", "parent", "affiliate", "subprocessor"]),
  jurisdiction: z.string(),
});

export const providerEntrySchema = z.object({
  id: z.string(),
  name: z.string(),
  status: z.enum(["VERIFIED", "UNVERIFIED", "FICTIONAL"]),
  description: z.string(),

  // Almost always one entry. More than one models a provider reachable
  // through genuinely different backends with different residency
  // characteristics (Claude via Anthropic's API vs. Bedrock vs. Vertex AI),
  // so the agent's search for one vendor name surfaces every path at once
  // instead of splitting them into unrelated provider ids.
  access_paths: z.array(accessPathSchema).min(1),

  what_to_look_for: z.array(z.string()).optional(),
  notes: z.string().optional(),

  headquarters_country: z.string().optional(),
  legal_entities: z.array(legalEntitySchema).optional(),
  subprocessors: z.array(z.string()).optional(),

  metadata: z
    .object({
      last_verified: z.string().optional(),
      maintainer: z.string().optional(),
    })
    .optional(),
  evidence: z.array(evidenceSchema).optional(),
});

export type ProviderEntry = z.infer<typeof providerEntrySchema>;
export type AccessPath = ProviderEntry["access_paths"][number];
export type RegionFact = z.infer<typeof regionFactSchema>;
