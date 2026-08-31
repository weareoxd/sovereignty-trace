import type { ValidationResult } from "./assessment/validation.js";
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
 * Plain-text summary for the Coverage section, shared with the HTML renderer
 * so both reports say the same thing.
 *
 * What used to go here was a verdict on whether the agent's citations could be
 * trusted. Citations are read out of the repository now, so the question is no
 * longer whether the report is trustworthy but whether it is complete: what was
 * dropped, and what was never answered.
 */
export function summarizeValidation(validation: ValidationResult): string {
  if (validation.errors.length > 0) {
    return "The agent's answer did not conform to the assessment schema, so no assessment was produced.";
  }
  if (validation.valid) {
    return "Every component category and policy point was answered, and every citation resolved against the repository.";
  }

  const parts: string[] = [];
  if (validation.droppedEvidence.length > 0) {
    parts.push(
      `${validation.droppedEvidence.length} citation(s) did not resolve against the repository and were dropped.`,
    );
  }
  if (validation.droppedFindings.length > 0) {
    parts.push(
      `${validation.droppedFindings.length} finding(s) were removed because every citation they had was dropped.`,
    );
  }
  const coverage =
    validation.warnings.length - validation.droppedEvidence.length - validation.droppedFindings.length;
  if (coverage > 0) {
    parts.push(`${coverage} category or policy point(s) went unanswered and are recorded as unknown.`);
  }

  return parts.join(" ");
}

/** Renders a sovereignty assessment as a Markdown report. */
export function renderMarkdownReport(
  assessment: SovereigntyAssessment,
  validation: ValidationResult,
  runInfo: RunInfo,
): string {
  const lines: string[] = [];

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
    lines.push(`- Schema retries: ${runInfo.repairRounds}`);
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
  for (const component of assessment.components) {
    lines.push(`### ${component.category}`);
    lines.push("");
    lines.push(component.summary);
    lines.push("");
    for (const finding of component.findings) {
      lines.push(`- **${finding.name}** (risk: ${finding.riskLevel})`);
      lines.push(`  ${finding.description}`);
      lines.push(`  - Provider: ${finding.provider} (\`${finding.providerReference.id}\`)`);
      lines.push(`  - Classification: ${finding.classification}`);
      lines.push(`  - Path: ${finding.activePath ? "default or currently active" : "alternate, not the active path"}`);
      lines.push(`  - Destination jurisdiction: ${finding.destinationJurisdiction}`);
      if (finding.crossesBorder !== undefined) {
        lines.push(`  - Crosses Canadian border: ${finding.crossesBorder ? "yes" : "no"}`);
      }
      if (finding.dataCategories.length > 0) {
        lines.push(`  - Data categories: ${finding.dataCategories.join(", ")}`);
      }
      for (const evidence of finding.evidence) {
        const loc = evidence.lines ? `${evidence.file}:${evidence.lines}` : evidence.file;
        lines.push(`  - Evidence: \`${loc}\`${evidence.note ? ` — ${evidence.note}` : ""}`);
      }
      if (finding.notes) lines.push(`  - Notes: ${finding.notes}`);
    }
    lines.push("");
  }

  if (assessment.policyAlignment.length > 0) {
    lines.push("## Policy alignment");
    lines.push("");
    for (const alignment of assessment.policyAlignment) {
      const ref = alignment.policyReference;
      lines.push(`- **${ref.title}** (\`${ref.id}#${ref.section}\`) — ${alignment.status}`);
      lines.push(`  ${alignment.explanation}`);
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

  lines.push("## Coverage");
  lines.push("");
  lines.push(summarizeValidation(validation));

  if (validation.errors.length > 0) {
    lines.push("");
    lines.push("Errors:");
    for (const error of validation.errors) {
      lines.push(`- \`${error.path}\`: ${error.message}`);
    }
  }
  if (validation.warnings.length > 0) {
    lines.push("");
    lines.push("Details:");
    for (const warning of validation.warnings) {
      lines.push(`- \`${warning.path}\`: ${warning.message}`);
    }
  }
  lines.push("");

  return lines.join("\n");
}
