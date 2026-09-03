import { z } from "zod";
import { listPolicyRules, listProviderIds } from "../knowledge/index.js";
import { NO_MATCHING_RECORD, SELF_HOSTED } from "./residency.js";

/**
 * The two shapes of a sovereignty assessment.
 *
 * `AssessmentDraft` is what the coding agent returns: observations only. What
 * it found, what the code does, which knowledge record applies, what kind of
 * data is involved, and where in the repository each claim can be checked.
 *
 * `SovereigntyAssessment` is the finished document. Everything the draft
 * doesn't carry — the snippets, the jurisdictions, the risk scores — is
 * computed from the draft and the knowledge base by ../run-assessment.ts.
 *
 * The split exists because the agent used to fill in every field of the second
 * shape directly, including the scores, and five runs of the same repository
 * disagreed with each other. Anything that is a lookup or a calculation is on
 * the code side of this line.
 *
 * Findings are a flat list, not nested inside the component categories. They
 * used to be nested, which meant a thing that belongs to two categories — a
 * managed search cluster is both a database and infrastructure — had to be
 * reported twice, once under each. The two copies then drifted: one BC Parks
 * run described the same OpenSearch cluster as `personal_information` under
 * "database" and `operational` under "infrastructure", scoring it High and Low
 * in the same document. A finding names one primary category and lists any
 * others it is relevant to, so one real thing gets one classification and one
 * score however many lenses it belongs under.
 */

export const RiskLevelSchema = z.enum(["low", "medium", "high", "unknown"]);
export type RiskLevel = z.infer<typeof RiskLevelSchema>;

export const ComponentCategorySchema = z.enum([
  "data_storage",
  "database",
  "queue_or_messaging",
  "logging_and_telemetry",
  "external_service",
  "ai_integration",
  "infrastructure",
  "configuration",
  "authentication_and_identity",
  "other",
]);
export type ComponentCategory = z.infer<typeof ComponentCategorySchema>;

export const COMPONENT_CATEGORIES = ComponentCategorySchema.options;

/**
 * How the data in a finding is classified. The first three come from the
 * policy records themselves: FOIPPA turns on "personal information", and the
 * cloud policy turns on the Protected B / Protected C security classifications.
 * The last four exist because assessments kept reporting things the policies
 * don't name — API keys, log payloads — and those need somewhere honest to go.
 *
 * This is what ./risk.ts scores from, which is why it is an enum. The
 * free-text `dataCategories` list stays alongside it for the prose: across five
 * runs that field produced 135 distinct labels for one repository, so it can
 * describe a finding but it cannot decide one.
 */
export const DataClassificationSchema = z.enum([
  "personal_information",
  "protected_b",
  "protected_c",
  "credentials_or_secrets",
  "operational",
  "none_identified",
  "unclassified",
]);
export type DataClassification = z.infer<typeof DataClassificationSchema>;

export const PolicyAlignmentStatusSchema = z.enum([
  "aligned",
  "at_risk",
  "violated",
  "not_applicable",
  "unknown",
]);
export type PolicyAlignmentStatus = z.infer<typeof PolicyAlignmentStatusSchema>;

/* -------------------------------------------------------------------------- */
/* What the agent returns                                                     */
/* -------------------------------------------------------------------------- */

export const DraftEvidenceSchema = z.object({
  file: z
    .string()
    .describe("Repository-relative path to the file you read, e.g. \"src/mail/send.ts\"."),
  lines: z
    .string()
    .describe('Line number or inclusive range within that file, e.g. "42" or "12-18".'),
  note: z.string().optional().describe("Why this location supports the finding."),
});
export type DraftEvidence = z.infer<typeof DraftEvidenceSchema>;

export const DraftFindingSchema = z.object({
  name: z.string().describe('Short label, e.g. "Application logs shipped to Datadog".'),
  description: z.string().describe("What the code does, in plain language."),
  category: ComponentCategorySchema.describe(
    "The category this finding belongs under most directly. Report the thing once, here — do not repeat it under every category it touches.",
  ),
  alsoRelevantTo: z
    .array(ComponentCategorySchema)
    .default([])
    .describe(
      'The other categories this same finding is relevant to, if any. A managed search cluster reported under "database" would list "infrastructure" here. It is cross-referenced under those categories rather than repeated, so do not also submit it as a separate finding.',
    ),
  providerId: z
    .string()
    .describe(
      "Which Sovereignty Graph provider record this involves. Pick from the provider index in your instructions.",
    ),
  classification: DataClassificationSchema.describe(
    "How the data moving through here is classified. This determines the finding's risk level, so pick the tier the evidence supports rather than the safest-sounding one.",
  ),
  dataCategories: z
    .array(z.string())
    .default([])
    .describe(
      'Plain-language description of the data involved, for the report prose, e.g. "recipient email addresses", "delivery status". Does not affect the risk level.',
    ),
  activePath: z
    .boolean()
    .describe(
      "True if this is the default or currently-active configuration. False if it is an alternate adapter behind a flag, or documented as not enabled. This lowers the risk tier, so only set it false when the repository shows the path is not in use.",
    ),
  configuredRegion: z
    .string()
    .optional()
    .describe(
      'The cloud region this deployment pins, copied exactly as the repository writes it, e.g. "ca-central-1", "canadacentral", "northamerica-northeast1". Set it only when the repository actually shows the region — an IaC region field, a region variable\'s default, a region passed to an SDK client. Omit it when the provider has no region setting, or when the region is supplied at deploy time and is not in the repository. Do not infer one from a bucket name, a company\'s location, or a region string on a non-provider endpoint.',
    ),
  evidence: z
    .array(DraftEvidenceSchema)
    .min(1)
    .describe("Where in the repository this finding can be checked. At least one location."),
  notes: z
    .string()
    .optional()
    .describe(
      "Caveats. This is where a record that doesn't quite apply belongs — a vendor SDK pointed at a self-hosted endpoint, for example.",
    ),
});
export type DraftFinding = z.infer<typeof DraftFindingSchema>;

/**
 * The per-category prose. Findings live in the draft's flat `findings` list and
 * are filed under a category from there, so this carries the summary only.
 */
export const DraftComponentSchema = z.object({
  category: ComponentCategorySchema,
  summary: z.string().describe("What you found in this category. Say so plainly if nothing."),
});

export const DraftPolicyAlignmentSchema = z.object({
  ruleId: z
    .string()
    .describe("Which policy point this answers. Pick from the policy rules in your instructions."),
  status: PolicyAlignmentStatusSchema,
  explanation: z.string(),
});

export const AssessmentDraftSchema = z.object({
  summary: z.string().describe("Plain-language summary of the repository's data-sovereignty posture."),
  components: z
    .array(DraftComponentSchema)
    .describe(
      "One summary per component category. Answer all of them, including the ones with nothing to report.",
    ),
  findings: z
    .array(DraftFindingSchema)
    .default([])
    .describe(
      "Every finding, in one flat list. Each names the category it belongs under. Report each real thing once, no matter how many categories it touches.",
    ),
  policyAlignment: z
    .array(DraftPolicyAlignmentSchema)
    .default([])
    .describe("One entry per policy rule. Answer all of them."),
  openQuestions: z
    .array(z.string())
    .default([])
    .describe("What you could not resolve by reading the repository."),
  limitations: z
    .string()
    .optional()
    .describe("What this assessment could not verify, beyond the standing limits of static inspection."),
});
export type AssessmentDraft = z.infer<typeof AssessmentDraftSchema>;

/**
 * The draft schema with `providerId` and `ruleId` narrowed to the ids that
 * actually exist on disk, as JSON Schema for the agent's structured output.
 *
 * Built at runtime rather than hardcoded because the enum members are the
 * knowledge base's filenames. Showing the agent the list is the whole point:
 * assessments used to invent a plausible slug (`ches`) that no record matched,
 * because they were asked for an id they had never been shown.
 */
export async function assessmentDraftJsonSchema(): Promise<Record<string, unknown>> {
  const schema = await buildNarrowedDraftSchema();
  return z.toJSONSchema(schema, { target: "draft-7" }) as Record<string, unknown>;
}

/**
 * The same narrowed schema as a Zod object, for checking an answer while the
 * agent can still correct it (see ./review.ts). Runtimes that enforce the JSON
 * Schema natively never need this; swival does not, so it gates on this instead.
 */
export async function buildNarrowedDraftSchema() {
  // Sentinels first so the tuple type carries a literal head, which is what
  // z.enum needs to accept a runtime-built member list.
  const providerMembers: [string, ...string[]] = [
    NO_MATCHING_RECORD,
    SELF_HOSTED,
    ...(await listProviderIds()),
  ];
  const rules = await listPolicyRules();
  const firstRule = rules[0];
  if (!firstRule) throw new Error("No policy rules found in policies/; cannot build the draft schema.");
  const ruleMembers: [string, ...string[]] = [firstRule.id, ...rules.slice(1).map((rule) => rule.id)];

  return AssessmentDraftSchema.extend({
    findings: z
      .array(
        DraftFindingSchema.extend({
          providerId: z
            .enum(providerMembers)
            .describe(
              `Which provider record this involves. "${NO_MATCHING_RECORD}" if the registry has no record for the vendor; "${SELF_HOSTED}" if this runs inside the deployment's own infrastructure and is not a third party.`,
            ),
        }),
      )
      .default([]),
    policyAlignment: z
      .array(
        DraftPolicyAlignmentSchema.extend({
          ruleId: z.enum(ruleMembers),
        }),
      )
      .default([]),
  });
}

/* -------------------------------------------------------------------------- */
/* The finished document                                                      */
/* -------------------------------------------------------------------------- */

export const EvidenceSchema = z.object({
  file: z.string(),
  lines: z.string().optional(),
  snippet: z.string(),
  /** Stable key for this exact file and range, minted by ./evidence-handle.ts. */
  evidenceId: z.string().optional(),
  note: z.string().optional(),
});
export type Evidence = z.infer<typeof EvidenceSchema>;

export const ProviderReferenceSchema = z.object({
  id: z.string(),
  /** Whether a record for this id exists. Read off the registry, not asserted. */
  available: z.boolean(),
});
export type ProviderReference = z.infer<typeof ProviderReferenceSchema>;

export const PolicyReferenceSchema = z.object({
  /** Policy document id, e.g. "bc-foippa-overview". */
  id: z.string(),
  /** Citable-section id within that document. */
  section: z.string(),
  title: z.string(),
});
export type PolicyReference = z.infer<typeof PolicyReferenceSchema>;

export const DataMovementFindingSchema = z.object({
  name: z.string(),
  description: z.string(),
  provider: z.string().describe("Display name of the provider record, or how it was categorized."),
  providerReference: ProviderReferenceSchema,
  classification: DataClassificationSchema,
  dataCategories: z.array(z.string()).default([]),
  activePath: z.boolean(),
  destinationJurisdiction: z.string(),
  crossesBorder: z.boolean().optional(),
  /** The repository-configured region, when the finding reported one. */
  configuredRegion: z.string().optional(),
  /** The category this finding is filed under. */
  category: ComponentCategorySchema,
  /** Other categories it is relevant to, where it appears as a cross-reference. */
  alsoRelevantTo: z.array(ComponentCategorySchema).default([]),
  riskLevel: RiskLevelSchema,
  evidence: z.array(EvidenceSchema),
  notes: z.string().optional(),
});
export type DataMovementFinding = z.infer<typeof DataMovementFindingSchema>;

/**
 * A finding filed under another category that is also relevant to this one.
 * Enough to point a reader at it, not a second copy of it.
 */
export const CrossReferenceSchema = z.object({
  name: z.string(),
  /** The category the finding is reported under in full. */
  category: ComponentCategorySchema,
  riskLevel: RiskLevelSchema,
});
export type CrossReference = z.infer<typeof CrossReferenceSchema>;

export const ComponentAssessmentSchema = z.object({
  category: ComponentCategorySchema,
  summary: z.string(),
  /** Findings filed under this category. Each finding appears in exactly one. */
  findings: z.array(DataMovementFindingSchema).default([]),
  /** Findings reported elsewhere that named this category as also relevant. */
  alsoRelevantHere: z.array(CrossReferenceSchema).default([]),
});
export type ComponentAssessment = z.infer<typeof ComponentAssessmentSchema>;

export const PolicyAlignmentSchema = z.object({
  policyReference: PolicyReferenceSchema,
  status: PolicyAlignmentStatusSchema,
  explanation: z.string(),
});
export type PolicyAlignment = z.infer<typeof PolicyAlignmentSchema>;

export const SovereigntyAssessmentSchema = z.object({
  schemaVersion: z.literal("3.0"),
  summary: z.string(),
  overallRisk: RiskLevelSchema,
  components: z.array(ComponentAssessmentSchema),
  policyAlignment: z.array(PolicyAlignmentSchema).default([]),
  openQuestions: z.array(z.string()).default([]),
  limitations: z.string().optional(),
});
export type SovereigntyAssessment = z.infer<typeof SovereigntyAssessmentSchema>;
