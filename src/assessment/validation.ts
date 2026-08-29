import { existsSync } from "node:fs";
import { isAbsolute, join, normalize, relative } from "node:path";
import { getPolicy, getPolicySource, getProvider } from "../knowledge/index.js";
import {
  SovereigntyAssessmentSchema,
  type Evidence,
  type PolicyReference,
  type ProviderReference,
  type SovereigntyAssessment,
} from "./schema.js";

export interface ValidationIssue {
  path: string;
  message: string;
}

export interface ValidationResult {
  valid: boolean;
  assessment?: SovereigntyAssessment;
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
}

/**
 * Validates a coding agent's raw structured output against the sovereignty
 * assessment schema, then does basic sanity-checking of what it cites:
 * every evidence `file` must exist in the repository that was assessed, and
 * every provider/policy record id it references must exist in Sovereignty
 * Graph's provider/policy knowledge. This does not verify that the cited
 * evidence or knowledge *supports* the finding — only that the agent didn't
 * cite something that doesn't exist.
 */
export async function validateAssessment(
  raw: unknown,
  options: { repositoryPath: string },
): Promise<ValidationResult> {
  const parsed = SovereigntyAssessmentSchema.safeParse(raw);

  if (!parsed.success) {
    return {
      valid: false,
      errors: parsed.error.issues.map((issue) => ({
        path: issue.path.join("."),
        message: issue.message,
      })),
      warnings: [],
    };
  }

  const assessment = parsed.data;
  const errors: ValidationIssue[] = [];
  const warnings: ValidationIssue[] = [];

  for (const [componentIndex, component] of assessment.components.entries()) {
    for (const [findingIndex, finding] of component.findings.entries()) {
      const pathPrefix = `components[${componentIndex}].findings[${findingIndex}]`;
      checkEvidence(finding.evidence, pathPrefix, options.repositoryPath, errors, warnings);
      if (finding.providerReference) {
        await checkProviderReference(finding.providerReference, `${pathPrefix}.providerReference`, errors);
      }
    }
  }

  for (const [policyIndex, policy] of assessment.policyAlignment.entries()) {
    const pathPrefix = `policyAlignment[${policyIndex}]`;
    checkEvidence(policy.evidence, pathPrefix, options.repositoryPath, errors, warnings);
    await checkPolicyReference(policy.policyReference, `${pathPrefix}.policyReference`, errors, warnings);
  }

  return {
    valid: errors.length === 0,
    assessment,
    errors,
    warnings,
  };
}

async function checkProviderReference(
  reference: ProviderReference,
  path: string,
  errors: ValidationIssue[],
): Promise<void> {
  const record = await getProvider(reference.id);
  if (reference.available && !record) {
    errors.push({
      path,
      message: `Provider record "${reference.id}" is marked available but does not exist in SG provider knowledge (providers/).`,
    });
  }
  if (!reference.available && record) {
    errors.push({
      path,
      message: `Provider record "${reference.id}" is marked unavailable ("no SG record found"), but a record for "${reference.id}" does exist in SG provider knowledge (providers/). Either the wrong id was cited, or \`available\` was incorrectly set to false to express that the record doesn't apply to this specific instance (e.g. a vendor SDK used against a non-vendor endpoint) — that nuance belongs in the finding's notes, not in \`available\`.`,
    });
  }
}

async function checkPolicyReference(
  reference: PolicyReference,
  path: string,
  errors: ValidationIssue[],
  warnings: ValidationIssue[],
): Promise<void> {
  const record = await getPolicy(reference.id);
  if (!record) {
    errors.push({
      path,
      message: `Policy record "${reference.id}" is referenced but does not exist in SG policy knowledge (policies/).`,
    });
  }

  if (reference.sourceId) {
    const source = await getPolicySource(reference.sourceId);
    if (!source) {
      warnings.push({
        path: `${path}.sourceId`,
        message: `Policy source "${reference.sourceId}" was not found in SG policy source knowledge (it may not be modeled separately for this policy record).`,
      });
    }
  }
}

function checkEvidence(
  evidence: Evidence[],
  pathPrefix: string,
  repositoryPath: string,
  errors: ValidationIssue[],
  warnings: ValidationIssue[],
): void {
  for (const [evidenceIndex, item] of evidence.entries()) {
    const evidencePath = `${pathPrefix}.evidence[${evidenceIndex}]`;

    if (isAbsolute(item.file)) {
      warnings.push({
        path: evidencePath,
        message: `Evidence file "${item.file}" is an absolute path; expected a path relative to the repository root.`,
      });
      continue;
    }

    const resolved = normalize(join(repositoryPath, item.file));
    const rel = relative(repositoryPath, resolved);
    if (rel.startsWith("..")) {
      errors.push({
        path: evidencePath,
        message: `Evidence file "${item.file}" resolves outside the repository.`,
      });
      continue;
    }

    if (!existsSync(resolved)) {
      errors.push({
        path: evidencePath,
        message: `Evidence file "${item.file}" does not exist in the repository.`,
      });
    }
  }
}
