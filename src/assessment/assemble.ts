import { getProvider, listPolicyRules, type PolicyRule } from "../knowledge/index.js";
import { hydrateEvidence, type DroppedEvidence } from "./hydrate-evidence.js";
import { NO_MATCHING_RECORD, resolveResidency, SELF_HOSTED } from "./residency.js";
import { rollUpRisk, scoreFinding } from "./risk.js";
import {
  COMPONENT_CATEGORIES,
  type AssessmentDraft,
  type ComponentAssessment,
  type DataMovementFinding,
  type PolicyAlignment,
  type SovereigntyAssessment,
} from "./schema.js";

/**
 * Stages 3 through 6: turn the agent's observations into the finished
 * assessment.
 *
 * Everything added here is derived — the snippets from the repository, the
 * jurisdictions from the provider records, the risk levels from ./risk.ts.
 * Nothing is asked of the agent a second time, and nothing here makes a
 * judgment call. Given the same draft and the same knowledge base, this
 * produces the same document every time.
 */

export interface DroppedFinding {
  path: string;
  name: string;
  reason: string;
}

export interface AssemblyResult {
  assessment: SovereigntyAssessment;
  /** Citations that did not resolve against the repository. */
  droppedEvidence: DroppedEvidence[];
  /** Findings removed because every citation they had was dropped. */
  droppedFindings: DroppedFinding[];
  /** Component categories the agent did not report on. */
  missingCategories: string[];
  /** Policy rules the agent did not answer. */
  missingRules: string[];
}

export async function assembleAssessment(
  draft: AssessmentDraft,
  options: { repositoryPath: string; files: string[] },
): Promise<AssemblyResult> {
  const droppedEvidence: DroppedEvidence[] = [];
  const droppedFindings: DroppedFinding[] = [];

  const byCategory = new Map(draft.components.map((component) => [component.category, component]));
  const components: ComponentAssessment[] = [];

  // Iterate the canonical category list rather than what the draft happened to
  // contain, so a category the agent skipped shows up as unreported instead of
  // silently vanishing from the report.
  for (const category of COMPONENT_CATEGORIES) {
    const drafted = byCategory.get(category);
    if (!drafted) {
      components.push({
        category,
        summary: "Not reported. The assessment did not cover this category.",
        findings: [],
      });
      continue;
    }

    const findings: DataMovementFinding[] = [];
    for (const [index, finding] of drafted.findings.entries()) {
      const path = `components[${category}].findings[${index}]`;
      const hydrated = await hydrateEvidence(finding.evidence, path, options.repositoryPath, options.files);
      droppedEvidence.push(...hydrated.dropped);

      // A finding is what its evidence says it is. With none left there is
      // nothing to check it against, so it goes rather than standing on a
      // citation that did not resolve.
      if (hydrated.evidence.length === 0) {
        droppedFindings.push({
          path,
          name: finding.name,
          reason: `All ${finding.evidence.length} citation(s) failed to resolve against the repository.`,
        });
        continue;
      }

      const residency = await resolveResidency(finding.providerId);
      findings.push({
        name: finding.name,
        description: finding.description,
        provider: await providerDisplayName(finding.providerId),
        providerReference: { id: finding.providerId, available: residency.providerAvailable },
        classification: finding.classification,
        dataCategories: finding.dataCategories,
        activePath: finding.activePath,
        destinationJurisdiction: residency.destinationJurisdiction,
        crossesBorder: residency.crossesBorder,
        riskLevel: scoreFinding({
          classification: finding.classification,
          residency: residency.status,
          activePath: finding.activePath,
        }),
        evidence: hydrated.evidence,
        notes: finding.notes,
      });
    }

    components.push({ category, summary: drafted.summary, findings });
  }

  const rules = await listPolicyRules();
  const answered = new Map(draft.policyAlignment.map((entry) => [entry.ruleId, entry]));
  const policyAlignment: PolicyAlignment[] = rules.map((rule) => {
    const entry = answered.get(rule.id);
    return {
      policyReference: referenceFor(rule),
      status: entry?.status ?? "unknown",
      explanation: entry?.explanation ?? "Not addressed by this assessment.",
    };
  });

  const allRisks = components.flatMap((component) => component.findings.map((finding) => finding.riskLevel));

  return {
    assessment: {
      schemaVersion: "2.0",
      summary: draft.summary,
      overallRisk: rollUpRisk(allRisks),
      components,
      policyAlignment,
      openQuestions: draft.openQuestions,
      limitations: draft.limitations,
    },
    droppedEvidence,
    droppedFindings,
    missingCategories: COMPONENT_CATEGORIES.filter((category) => !byCategory.has(category)),
    missingRules: rules.filter((rule) => !answered.has(rule.id)).map((rule) => rule.id),
  };
}

function referenceFor(rule: PolicyRule) {
  return { id: rule.policyId, section: rule.id, title: rule.title };
}

async function providerDisplayName(providerId: string): Promise<string> {
  if (providerId === SELF_HOSTED) return "Self-hosted (not a third party)";
  if (providerId === NO_MATCHING_RECORD) return "No Sovereignty Graph record";
  return (await getProvider(providerId))?.title ?? providerId;
}
