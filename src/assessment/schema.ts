import { z } from "zod";

/**
 * Structured sovereignty assessment schema. This is the contract between
 * Sovereignty Graph and the coding agent: the agent's final answer must
 * conform to this shape, every finding must cite the repository evidence
 * it is based on, and every provider/policy claim must cite the SG
 * knowledge record (see ../knowledge/) it was grounded in.
 */

export const EvidenceSchema = z.object({
  file: z.string().describe("Repository-relative file path supporting this finding."),
  lines: z
    .string()
    .optional()
    .describe('Line number or range within the file, e.g. "12-18".'),
  snippet: z
    .string()
    .describe("Short excerpt (a few lines) substantiating the finding."),
  note: z.string().optional().describe("Why this evidence supports the finding."),
});
export type Evidence = z.infer<typeof EvidenceSchema>;

export const RiskLevelSchema = z.enum(["low", "medium", "high", "unknown"]);
export type RiskLevel = z.infer<typeof RiskLevelSchema>;

export const ProviderReferenceSchema = z.object({
  id: z
    .string()
    .describe(
      'Sovereignty Graph provider record id (from sg_search_providers / sg_get_provider), e.g. "aws". Required even when `available` is false — record the id you looked up.',
    ),
  available: z
    .boolean()
    .describe(
      "Whether sg_get_provider returned a record for this id — nothing else. False means SG has no provider knowledge for this vendor; say so in the finding's notes rather than guessing its residency. Do not set this to false to express that the record doesn't really apply to this instance (e.g. a vendor SDK used against a self-hosted endpoint that isn't actually that vendor) — if sg_get_provider found a record, this is true, and that nuance belongs in the finding's notes instead.",
    ),
});
export type ProviderReference = z.infer<typeof ProviderReferenceSchema>;

export const PolicyReferenceSchema = z.object({
  id: z
    .string()
    .describe(
      'Sovereignty Graph policy record id (from sg_search_policies / sg_get_policy), e.g. "bc-foippa-overview". Do not include a "#section" suffix here — use `section` instead.',
    ),
  section: z
    .string()
    .optional()
    .describe(
      'Anchor/section within the policy record this addresses, e.g. "personal-information-outside-canada", if the record documents one.',
    ),
  sourceId: z
    .string()
    .optional()
    .describe(
      "Id of a separate underlying source document retrieved via sg_get_policy_source, if the policy record referenced one.",
    ),
});
export type PolicyReference = z.infer<typeof PolicyReferenceSchema>;

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

export const DataMovementFindingSchema = z.object({
  name: z.string().describe('Short label for this finding, e.g. "Application logs shipped to Datadog".'),
  description: z.string().describe("What the code does, in plain language."),
  provider: z
    .string()
    .optional()
    .describe('Vendor or service name involved, e.g. "AWS S3", "OpenAI API", "self-hosted".'),
  providerReference: ProviderReferenceSchema.optional().describe(
    "The SG provider knowledge lookup grounding this finding's jurisdiction claim. Omit only when the finding involves no third-party provider (e.g. purely local/in-process behavior).",
  ),
  dataCategories: z
    .array(z.string())
    .default([])
    .describe('Types of data involved, e.g. "personal information", "credentials", "application logs".'),
  destinationJurisdiction: z
    .string()
    .optional()
    .describe('Best-effort jurisdiction data is sent to or stored in, e.g. "Canada", "United States", "unknown".'),
  crossesBorder: z
    .boolean()
    .optional()
    .describe("Whether this data movement is understood to leave Canada. Omit if not determinable from the repository."),
  riskLevel: RiskLevelSchema,
  evidence: z.array(EvidenceSchema).min(1).describe("At least one piece of repository evidence is required."),
  notes: z.string().optional(),
});
export type DataMovementFinding = z.infer<typeof DataMovementFindingSchema>;

export const ComponentAssessmentSchema = z.object({
  category: ComponentCategorySchema,
  summary: z.string().describe("Summary of what was found in this category, even if nothing notable."),
  findings: z.array(DataMovementFindingSchema).default([]),
});
export type ComponentAssessment = z.infer<typeof ComponentAssessmentSchema>;

export const PolicyAlignmentStatusSchema = z.enum([
  "aligned",
  "at_risk",
  "violated",
  "not_applicable",
  "unknown",
]);
export type PolicyAlignmentStatus = z.infer<typeof PolicyAlignmentStatusSchema>;

export const PolicyAlignmentSchema = z.object({
  policyReference: PolicyReferenceSchema.describe(
    "The SG policy knowledge lookup this alignment finding is based on.",
  ),
  status: PolicyAlignmentStatusSchema,
  explanation: z.string(),
  evidence: z.array(EvidenceSchema).default([]),
});
export type PolicyAlignment = z.infer<typeof PolicyAlignmentSchema>;

export const SovereigntyAssessmentSchema = z.object({
  schemaVersion: z.literal("1.0"),
  summary: z
    .string()
    .describe("Plain-language summary of the repository's data-sovereignty posture."),
  overallRisk: RiskLevelSchema,
  components: z
    .array(ComponentAssessmentSchema)
    .describe("One entry per investigated category, covering all ComponentCategory values that apply."),
  policyAlignment: z
    .array(PolicyAlignmentSchema)
    .default([])
    .describe("How the findings above line up against the SG policy knowledge records retrieved during this assessment."),
  openQuestions: z
    .array(z.string())
    .default([])
    .describe("Questions the agent could not resolve from static repository inspection alone."),
  limitations: z
    .string()
    .optional()
    .describe("What this assessment could not verify (e.g. runtime behavior, third-party subprocessors)."),
});
export type SovereigntyAssessment = z.infer<typeof SovereigntyAssessmentSchema>;

/** JSON Schema form of {@link SovereigntyAssessmentSchema}, for CodingAgent outputSchema. */
export function sovereigntyAssessmentJsonSchema(): Record<string, unknown> {
  return z.toJSONSchema(SovereigntyAssessmentSchema, { target: "draft-7" }) as Record<
    string,
    unknown
  >;
}
