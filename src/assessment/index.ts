export {
  AssessmentDraftSchema,
  ComponentAssessmentSchema,
  ComponentCategorySchema,
  COMPONENT_CATEGORIES,
  DataClassificationSchema,
  DataMovementFindingSchema,
  DraftEvidenceSchema,
  DraftFindingSchema,
  EvidenceSchema,
  PolicyAlignmentSchema,
  PolicyAlignmentStatusSchema,
  PolicyReferenceSchema,
  ProviderReferenceSchema,
  RiskLevelSchema,
  SovereigntyAssessmentSchema,
  assessmentDraftJsonSchema,
  buildNarrowedDraftSchema,
} from "./schema.js";
export type {
  AssessmentDraft,
  ComponentAssessment,
  ComponentCategory,
  DataClassification,
  DataMovementFinding,
  DraftEvidence,
  DraftFinding,
  Evidence,
  PolicyAlignment,
  PolicyAlignmentStatus,
  PolicyReference,
  ProviderReference,
  RiskLevel,
  SovereigntyAssessment,
} from "./schema.js";
export { buildAssessmentInstructions, type AssessmentInstructionsInput } from "./methodology.js";
export { validateAssessment, type ValidationIssue, type ValidationResult } from "./validation.js";
export { assembleAssessment, type AssemblyResult, type DroppedFinding } from "./assemble.js";
export {
  hydrateEvidence,
  parseLineRange,
  type DroppedEvidence,
  type EvidenceDropReason,
  type HydrationResult,
} from "./hydrate-evidence.js";
export {
  resolveResidency,
  NO_MATCHING_RECORD,
  SELF_HOSTED,
  type ResidencyFacts,
  type ResidencyStatus,
} from "./residency.js";
export { rollUpRisk, scoreFinding, type RiskInputs } from "./risk.js";
export { suggestNearestPath } from "./nearest-path.js";
export {
  formatLineRange,
  mintEvidenceHandle,
  sliceLines,
  MAX_EVIDENCE_LINES,
  type EvidenceSlice,
} from "./evidence-handle.js";
export {
  gatherRepositoryInfo,
  listRepositoryFiles,
  type RepositoryInfo,
} from "./repository-info.js";
