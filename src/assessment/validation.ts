import { assembleAssessment, type DroppedFinding } from "./assemble.js";
import type { DroppedEvidence } from "./hydrate-evidence.js";
import { AssessmentDraftSchema, type SovereigntyAssessment } from "./schema.js";

/**
 * What is left to check once the agent stops writing derived fields.
 *
 * This used to verify that cited files existed, that quoted snippets really
 * appeared in them, and that a provider record the agent marked "found" had
 * actually been found — because all three were things the agent typed from
 * memory. None of them are any more. Evidence is read out of the repository in
 * ./hydrate-evidence.ts and provider facts come off the record in
 * ./residency.ts, so what remains is: does the draft parse, and did the
 * assessment cover the ground it was asked to.
 */

export interface ValidationIssue {
  path: string;
  message: string;
}

export interface ValidationResult {
  valid: boolean;
  assessment?: SovereigntyAssessment;
  /** Failures that leave no usable assessment: the draft did not parse. */
  errors: ValidationIssue[];
  /** Coverage gaps and dropped citations. The assessment stands; it is incomplete. */
  warnings: ValidationIssue[];
  droppedEvidence: DroppedEvidence[];
  droppedFindings: DroppedFinding[];
}

export async function validateAssessment(
  raw: unknown,
  options: { repositoryPath: string; files: string[] },
): Promise<ValidationResult> {
  const parsed = AssessmentDraftSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      valid: false,
      errors: parsed.error.issues.map((issue) => ({
        path: issue.path.join("."),
        message: issue.message,
      })),
      warnings: [],
      droppedEvidence: [],
      droppedFindings: [],
    };
  }

  const result = await assembleAssessment(parsed.data, options);
  const warnings: ValidationIssue[] = [];

  for (const category of result.missingCategories) {
    warnings.push({
      path: `components[${category}]`,
      message: `Component category "${category}" was not reported on.`,
    });
  }

  for (const ruleId of result.missingRules) {
    warnings.push({
      path: `policyAlignment[${ruleId}]`,
      message: `Policy rule "${ruleId}" was not answered; recorded as unknown.`,
    });
  }

  for (const dropped of result.droppedEvidence) {
    warnings.push({
      path: dropped.path,
      message:
        `Citation to ${dropped.file}:${dropped.lines} was dropped (${dropped.reason}): ${dropped.message}` +
        (dropped.suggestion ? ` Closest repository file: ${dropped.suggestion}.` : ""),
    });
  }

  for (const dropped of result.droppedFindings) {
    warnings.push({ path: dropped.path, message: `Finding "${dropped.name}" removed: ${dropped.reason}` });
  }

  return {
    valid: warnings.length === 0,
    assessment: result.assessment,
    errors: [],
    warnings,
    droppedEvidence: result.droppedEvidence,
    droppedFindings: result.droppedFindings,
  };
}
