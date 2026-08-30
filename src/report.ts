import {
  indexEvidenceChecks,
  indexTaintedFindings,
  unverifiedEvidence,
  type EvidenceCheck,
  type ValidationResult,
} from "./assessment/validation.js";
import type { SovereigntyAssessment } from "./assessment/schema.js";
import type { RunInfo } from "./run-info.js";

const RISK_LABEL: Record<string, string> = {
  low: "Low",
  medium: "Medium",
  high: "High",
  unknown: "Unknown",
};

/** Formats a duration as e.g. "1h 4m 12s", "4m 12s", or "12s". */
export function formatDuration(durationMs: number): string {
  const totalSeconds = Math.max(0, Math.round(durationMs / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  const parts: string[] = [];
  if (hours > 0) parts.push(`${hours}h`);
  if (hours > 0 || minutes > 0) parts.push(`${minutes}m`);
  parts.push(`${seconds}s`);
  return parts.join(" ");
}

/**
 * One-line plain-text account of a citation that failed verification,
 * including the nearest matching repository file when one was found. Shared
 * with the HTML renderer so both reports say the same thing.
 */
export function describeEvidenceProblem(check: EvidenceCheck | undefined): string | undefined {
  if (!check || check.verdict === "verified") return undefined;
  return `${check.message ?? check.verdict}${suggestionText(check)}`;
}

function suggestionText(check: EvidenceCheck): string {
  return check.suggestion ? ` Did you mean \`${check.suggestion}\`?` : "";
}

/**
 * Plain-text summary for the Validation section. Unverified citations are
 * reported as a count against the findings that made them, rather than as a
 * blanket judgement on the assessment, so one bad path doesn't read as "none
 * of this is trustworthy".
 */
export function summarizeValidation(validation: ValidationResult): string {
  if (validation.valid) {
    return "All cited evidence, provider records, and policy records resolved successfully.";
  }

  const parts: string[] = [];
  const unverified = unverifiedEvidence(validation);

  if (unverified.length > 0) {
    parts.push(
      `${unverified.length} of ${validation.evidenceChecks.length} evidence citations could not be ` +
        `verified, across ${validation.taintedFindings.length} finding(s). Those findings are marked ` +
        "above. The rest of the report is unaffected.",
    );
  }
  if (validation.errors.length > 0) {
    parts.push(
      "This assessment failed structural or knowledge-record validation. Treat it as unverified.",
    );
  }

  return parts.join(" ");
}

/** Renders a sovereignty assessment (and its validation result) as a Markdown report. */
export function renderMarkdownReport(
  assessment: SovereigntyAssessment,
  validation: ValidationResult,
  runInfo: RunInfo,
): string {
  const lines: string[] = [];
  const checksByPath = indexEvidenceChecks(validation.evidenceChecks);
  const taintByPath = indexTaintedFindings(validation.taintedFindings);

  lines.push(`# Sovereignty Assessment: ${runInfo.repositoryName}`);
  lines.push("");
  lines.push(`- Assessed at: ${runInfo.assessedAt}`);
  lines.push(`- Overall risk: **${RISK_LABEL[assessment.overallRisk] ?? assessment.overallRisk}**`);
  if (runInfo.commit) {
    lines.push(`- Commit: \`${runInfo.commit}\``);
  }
  if (runInfo.primaryLanguages.length > 0) {
    lines.push(`- Primary languages: ${runInfo.primaryLanguages.join(", ")}`);
  }
  lines.push(`- Duration: ${formatDuration(runInfo.durationMs)}`);
  lines.push(`- Agent: ${runInfo.agentName}${runInfo.model ? ` (${runInfo.model})` : ""}`);
  if (runInfo.repairRounds > 0) {
    lines.push(`- Evidence repair rounds: ${runInfo.repairRounds}`);
  }
  if (runInfo.usage?.totalCostUsd !== undefined) {
    lines.push(`- Estimated cost: $${runInfo.usage.totalCostUsd.toFixed(4)}`);
  }
  lines.push(`- Session: \`${runInfo.sessionId}\``);
  lines.push("");
  lines.push("## Summary");
  lines.push("");
  lines.push(assessment.summary);
  lines.push("");

  lines.push("## Findings by component");
  lines.push("");
  for (const [componentIndex, component] of assessment.components.entries()) {
    lines.push(`### ${component.category}`);
    lines.push("");
    lines.push(component.summary);
    lines.push("");
    for (const [findingIndex, finding] of component.findings.entries()) {
      const findingPath = `components[${componentIndex}].findings[${findingIndex}]`;
      const taint = taintByPath.get(findingPath);
      const taintMark = taint && taint.verified === 0 ? " **[EVIDENCE UNVERIFIED]**" : "";
      lines.push(`- **${finding.name}** (risk: ${finding.riskLevel})${taintMark}`);
      lines.push(`  ${finding.description}`);
      if (finding.provider) lines.push(`  - Provider: ${finding.provider}`);
      if (finding.providerReference) {
        const ref = finding.providerReference;
        lines.push(
          `  - SG provider record: \`${ref.id}\`${ref.available ? "" : " (no SG record found for this provider)"}`,
        );
      }
      if (finding.destinationJurisdiction) {
        lines.push(`  - Destination jurisdiction: ${finding.destinationJurisdiction}`);
      }
      if (finding.crossesBorder !== undefined) {
        lines.push(`  - Crosses Canadian border: ${finding.crossesBorder ? "yes" : "no"}`);
      }
      if (finding.dataCategories.length > 0) {
        lines.push(`  - Data categories: ${finding.dataCategories.join(", ")}`);
      }
      for (const [evidenceIndex, evidence] of finding.evidence.entries()) {
        const loc = evidence.lines ? `${evidence.file}:${evidence.lines}` : evidence.file;
        lines.push(`  - Evidence: \`${loc}\`${evidence.note ? ` — ${evidence.note}` : ""}`);
        const flag = describeEvidenceProblem(checksByPath.get(`${findingPath}.evidence[${evidenceIndex}]`));
        if (flag) lines.push(`    - **Unverified:** ${flag}`);
      }
      if (finding.notes) lines.push(`  - Notes: ${finding.notes}`);
    }
    lines.push("");
  }

  if (assessment.policyAlignment.length > 0) {
    lines.push("## Policy alignment");
    lines.push("");
    for (const [policyIndex, alignment] of assessment.policyAlignment.entries()) {
      const ref = alignment.policyReference;
      const refLabel = ref.section ? `${ref.id}#${ref.section}` : ref.id;
      lines.push(`- **${refLabel}** — ${alignment.status}`);
      lines.push(`  ${alignment.explanation}`);
      if (ref.sourceId) lines.push(`  - Source: \`${ref.sourceId}\``);
      for (const [evidenceIndex, evidence] of alignment.evidence.entries()) {
        const loc = evidence.lines ? `${evidence.file}:${evidence.lines}` : evidence.file;
        lines.push(`  - Evidence: \`${loc}\``);
        const flag = describeEvidenceProblem(
          checksByPath.get(`policyAlignment[${policyIndex}].evidence[${evidenceIndex}]`),
        );
        if (flag) lines.push(`    - **Unverified:** ${flag}`);
      }
    }
    lines.push("");
  }

  if (assessment.openQuestions.length > 0) {
    lines.push("## Open questions");
    lines.push("");
    for (const question of assessment.openQuestions) {
      lines.push(`- ${question}`);
    }
    lines.push("");
  }

  if (assessment.limitations) {
    lines.push("## Limitations");
    lines.push("");
    lines.push(assessment.limitations);
    lines.push("");
  }

  lines.push("## Validation");
  lines.push("");
  lines.push(summarizeValidation(validation));

  const unverified = unverifiedEvidence(validation);
  if (unverified.length > 0) {
    lines.push("");
    lines.push("Unverified evidence:");
    for (const check of unverified) {
      lines.push(`- \`${check.path}\`: ${describeEvidenceProblem(check)}`);
    }
  }
  if (validation.errors.length > 0) {
    lines.push("");
    lines.push("Errors:");
    for (const error of validation.errors) {
      lines.push(`- \`${error.path}\`: ${error.message}`);
    }
  }
  if (validation.warnings.length > 0) {
    lines.push("");
    lines.push("Warnings:");
    for (const warning of validation.warnings) {
      lines.push(`- \`${warning.path}\`: ${warning.message}`);
    }
  }
  lines.push("");

  return lines.join("\n");
}
