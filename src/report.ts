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

/** Renders a sovereignty assessment (and its validation result) as a Markdown report. */
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
      const refLabel = ref.section ? `${ref.id}#${ref.section}` : ref.id;
      lines.push(`- **${refLabel}** — ${alignment.status}`);
      lines.push(`  ${alignment.explanation}`);
      if (ref.sourceId) lines.push(`  - Source: \`${ref.sourceId}\``);
      for (const evidence of alignment.evidence) {
        const loc = evidence.lines ? `${evidence.file}:${evidence.lines}` : evidence.file;
        lines.push(`  - Evidence: \`${loc}\``);
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
  lines.push(
    validation.valid
      ? "All cited evidence, provider records, and policy records resolved successfully."
      : "This assessment failed validation. Treat it as unverified.",
  );
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
