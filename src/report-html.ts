import {
  indexEvidenceChecks,
  indexTaintedFindings,
  unverifiedEvidence,
  type EvidenceCheck,
  type FindingTaint,
  type ValidationResult,
} from "./assessment/validation.js";
import type { SovereigntyAssessment } from "./assessment/schema.js";
import { describeEvidenceProblem, formatDuration, summarizeValidation } from "./report.js";
import type { RunInfo } from "./run-info.js";

const RISK_LABEL: Record<string, string> = {
  low: "Low",
  medium: "Medium",
  high: "High",
  unknown: "Unknown",
};

const POLICY_STATUS_LABEL: Record<string, string> = {
  aligned: "Aligned",
  at_risk: "At risk",
  violated: "Violated",
  not_applicable: "Not applicable",
  unknown: "Unknown",
};

const CATEGORY_LABEL: Record<string, string> = {
  data_storage: "Data storage",
  database: "Database",
  queue_or_messaging: "Queue or messaging",
  logging_and_telemetry: "Logging and telemetry",
  external_service: "External service",
  ai_integration: "AI integration",
  infrastructure: "Infrastructure",
  configuration: "Configuration",
  authentication_and_identity: "Authentication and identity",
  other: "Other",
};

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function riskClass(risk: string): string {
  return `risk-${risk in RISK_LABEL ? risk : "unknown"}`;
}

function policyStatusClass(status: string): string {
  return `policy-${status in POLICY_STATUS_LABEL ? status : "unknown"}`;
}

function renderEvidence(
  evidence: SovereigntyAssessment["components"][number]["findings"][number]["evidence"],
  pathPrefix: string,
  checksByPath: Map<string, EvidenceCheck>,
): string {
  if (evidence.length === 0) return "";
  const items = evidence
    .map((e, index) => {
      const loc = e.lines ? `${e.file}:${e.lines}` : e.file;
      const note = e.note ? ` — ${escapeHtml(e.note)}` : "";
      const snippet = e.snippet
        ? `<pre class="snippet"><code>${escapeHtml(e.snippet)}</code></pre>`
        : "";
      const problem = describeEvidenceProblem(checksByPath.get(`${pathPrefix}.evidence[${index}]`));
      const flag = problem
        ? `<p class="evidence-problem"><strong>Unverified:</strong> ${escapeHtml(problem)}</p>`
        : "";
      return `<li class="${problem ? "evidence-unverified" : ""}"><code>${escapeHtml(
        loc,
      )}</code>${note}${flag}${snippet}</li>`;
    })
    .join("");
  return `<ul class="evidence">${items}</ul>`;
}

function renderFinding(
  finding: SovereigntyAssessment["components"][number]["findings"][number],
  path: string,
  checksByPath: Map<string, EvidenceCheck>,
  taint: FindingTaint | undefined,
): string {
  const parts: string[] = [];
  parts.push(`<div class="finding${taint ? " tainted" : ""}">`);
  parts.push(
    `<div class="finding-header"><span class="finding-name">${escapeHtml(finding.name)}</span>` +
      `<span class="badges">${
        taint ? `<span class="badge badge-unverified">Unverified evidence</span>` : ""
      }<span class="badge ${riskClass(finding.riskLevel)}">${
        RISK_LABEL[finding.riskLevel] ?? finding.riskLevel
      }</span></span></div>`,
  );
  parts.push(`<p class="finding-description">${escapeHtml(finding.description)}</p>`);

  const meta: string[] = [];
  if (finding.provider) meta.push(`<li><strong>Provider:</strong> ${escapeHtml(finding.provider)}</li>`);
  if (finding.providerReference) {
    const ref = finding.providerReference;
    meta.push(
      `<li><strong>SG provider record:</strong> <code>${escapeHtml(ref.id)}</code>${
        ref.available ? "" : " (no SG record found for this provider)"
      }</li>`,
    );
  }
  if (finding.destinationJurisdiction) {
    meta.push(`<li><strong>Destination jurisdiction:</strong> ${escapeHtml(finding.destinationJurisdiction)}</li>`);
  }
  if (finding.crossesBorder !== undefined) {
    meta.push(`<li><strong>Crosses Canadian border:</strong> ${finding.crossesBorder ? "yes" : "no"}</li>`);
  }
  if (finding.dataCategories.length > 0) {
    meta.push(`<li><strong>Data categories:</strong> ${escapeHtml(finding.dataCategories.join(", "))}</li>`);
  }
  if (finding.notes) meta.push(`<li><strong>Notes:</strong> ${escapeHtml(finding.notes)}</li>`);
  if (meta.length > 0) parts.push(`<ul class="finding-meta">${meta.join("")}</ul>`);

  const evidenceHtml = renderEvidence(finding.evidence, path, checksByPath);
  if (evidenceHtml) parts.push(evidenceHtml);

  parts.push(`</div>`);
  return parts.join("");
}

/** Renders a sovereignty assessment (and its validation result) as a self-contained HTML report. */
export function renderHtmlReport(
  assessment: SovereigntyAssessment,
  validation: ValidationResult,
  runInfo: RunInfo,
): string {
  const title = `Sovereignty Assessment: ${runInfo.repositoryName}`;
  const checksByPath = indexEvidenceChecks(validation.evidenceChecks);
  const taintByPath = indexTaintedFindings(validation.taintedFindings);

  const componentsHtml = assessment.components
    .map((component, componentIndex) => {
      const findingsHtml =
        component.findings.length > 0
          ? component.findings
              .map((finding, findingIndex) => {
                const path = `components[${componentIndex}].findings[${findingIndex}]`;
                return renderFinding(finding, path, checksByPath, taintByPath.get(path));
              })
              .join("")
          : `<p class="empty">No findings in this category.</p>`;
      return `
        <section class="component">
          <h3>${escapeHtml(CATEGORY_LABEL[component.category] ?? component.category)}</h3>
          <p class="component-summary">${escapeHtml(component.summary)}</p>
          ${findingsHtml}
        </section>`;
    })
    .join("");

  const policyHtml =
    assessment.policyAlignment.length > 0
      ? `
        <section id="policy">
          <h2>Policy alignment</h2>
          ${assessment.policyAlignment
            .map((alignment, policyIndex) => {
              const ref = alignment.policyReference;
              const refLabel = ref.section ? `${ref.id}#${ref.section}` : ref.id;
              const source = ref.sourceId ? `<li><strong>Source:</strong> <code>${escapeHtml(ref.sourceId)}</code></li>` : "";
              const path = `policyAlignment[${policyIndex}]`;
              const taint = taintByPath.get(path);
              return `
                <div class="finding${taint ? " tainted" : ""}">
                  <div class="finding-header">
                    <span class="finding-name"><code>${escapeHtml(refLabel)}</code></span>
                    <span class="badges">${
                      taint ? `<span class="badge badge-unverified">Unverified evidence</span>` : ""
                    }<span class="badge ${policyStatusClass(alignment.status)}">${
                POLICY_STATUS_LABEL[alignment.status] ?? alignment.status
              }</span></span>
                  </div>
                  <p class="finding-description">${escapeHtml(alignment.explanation)}</p>
                  <ul class="finding-meta">${source}</ul>
                  ${renderEvidence(alignment.evidence, path, checksByPath)}
                </div>`;
            })
            .join("")}
        </section>`
      : "";

  const openQuestionsHtml =
    assessment.openQuestions.length > 0
      ? `
        <section id="open-questions">
          <h2>Open questions</h2>
          <ul>${assessment.openQuestions.map((q) => `<li>${escapeHtml(q)}</li>`).join("")}</ul>
        </section>`
      : "";

  const limitationsHtml = assessment.limitations
    ? `
        <section id="limitations">
          <h2>Limitations</h2>
          <p>${escapeHtml(assessment.limitations)}</p>
        </section>`
    : "";

  const unverified = unverifiedEvidence(validation);
  const unverifiedHtml =
    unverified.length > 0
      ? `<ul class="validation-list validation-errors">${unverified
          .map(
            (check) =>
              `<li><code>${escapeHtml(check.path)}</code>: ${escapeHtml(
                describeEvidenceProblem(check) ?? "",
              )}</li>`,
          )
          .join("")}</ul>`
      : "";

  const validationErrorsHtml =
    validation.errors.length > 0
      ? `<ul class="validation-list validation-errors">${validation.errors
          .map((e) => `<li><code>${escapeHtml(e.path)}</code>: ${escapeHtml(e.message)}</li>`)
          .join("")}</ul>`
      : "";

  const validationWarningsHtml =
    validation.warnings.length > 0
      ? `<ul class="validation-list validation-warnings">${validation.warnings
          .map((w) => `<li><code>${escapeHtml(w.path)}</code>: ${escapeHtml(w.message)}</li>`)
          .join("")}</ul>`
      : "";

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
  :root {
    color-scheme: light dark;
    --bg: #ffffff;
    --fg: #1a1a1a;
    --muted: #5a5a5a;
    --border: #e0e0e0;
    --card-bg: #f7f7f8;
    --code-bg: #eef0f2;
    --low-bg: #e6f4ea; --low-fg: #1e7d34;
    --medium-bg: #fff4e0; --medium-fg: #9a6400;
    --high-bg: #fdeaea; --high-fg: #b3261e;
    --unknown-bg: #eceff1; --unknown-fg: #546e7a;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #14161a;
      --fg: #e8e8e8;
      --muted: #a0a0a0;
      --border: #2c2f36;
      --card-bg: #1c1f24;
      --code-bg: #23262c;
      --low-bg: #16301f; --low-fg: #7fd99a;
      --medium-bg: #3a2c0c; --medium-fg: #f0b93c;
      --high-bg: #3a1616; --high-fg: #f28b82;
      --unknown-bg: #2a2e33; --unknown-fg: #b0bec5;
    }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    padding: 2rem 1.5rem 4rem;
    background: var(--bg);
    color: var(--fg);
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
    line-height: 1.5;
  }
  main {
    max-width: 860px;
    margin: 0 auto;
  }
  h1 { font-size: 1.6rem; margin-bottom: 0.25rem; }
  h2 { font-size: 1.25rem; margin-top: 2.5rem; border-bottom: 1px solid var(--border); padding-bottom: 0.4rem; }
  h3 { font-size: 1.05rem; margin-bottom: 0.25rem; }
  p { margin: 0.5rem 0; }
  code {
    background: var(--code-bg);
    padding: 0.1rem 0.35rem;
    border-radius: 4px;
    font-size: 0.9em;
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  }
  pre.snippet {
    background: var(--code-bg);
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 0.6rem 0.8rem;
    overflow-x: auto;
    margin: 0.4rem 0 0.6rem;
  }
  pre.snippet code { background: none; padding: 0; }
  .meta-list {
    list-style: none;
    padding: 0;
    margin: 0.75rem 0 0;
    color: var(--muted);
    font-size: 0.95rem;
  }
  .meta-list li { margin: 0.15rem 0; }
  .badge {
    display: inline-block;
    padding: 0.15rem 0.6rem;
    border-radius: 999px;
    font-size: 0.8rem;
    font-weight: 600;
    white-space: nowrap;
  }
  .risk-low { background: var(--low-bg); color: var(--low-fg); }
  .risk-medium { background: var(--medium-bg); color: var(--medium-fg); }
  .risk-high { background: var(--high-bg); color: var(--high-fg); }
  .risk-unknown { background: var(--unknown-bg); color: var(--unknown-fg); }
  .policy-aligned { background: var(--low-bg); color: var(--low-fg); }
  .policy-at_risk { background: var(--medium-bg); color: var(--medium-fg); }
  .policy-violated { background: var(--high-bg); color: var(--high-fg); }
  .policy-not_applicable, .policy-unknown { background: var(--unknown-bg); color: var(--unknown-fg); }
  .component {
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 1rem 1.2rem;
    margin: 1rem 0;
    background: var(--card-bg);
  }
  .component-summary { color: var(--muted); }
  .empty { color: var(--muted); font-style: italic; }
  .finding {
    border-top: 1px solid var(--border);
    padding: 0.9rem 0 0.2rem;
    margin-top: 0.9rem;
  }
  .finding:first-of-type { border-top: none; margin-top: 0.4rem; padding-top: 0; }
  .finding-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.75rem;
  }
  .finding-name { font-weight: 600; }
  .finding-description { color: var(--fg); }
  .finding-meta { list-style: none; padding: 0; margin: 0.4rem 0; color: var(--muted); font-size: 0.92rem; }
  .finding-meta li { margin: 0.1rem 0; }
  ul.evidence { list-style: disc; margin: 0.4rem 0 0.2rem 1.2rem; padding: 0; font-size: 0.92rem; color: var(--muted); }
  ul.evidence li { margin: 0.2rem 0; }
  .badges { display: inline-flex; align-items: center; gap: 0.4rem; }
  .badge-unverified { background: var(--high-bg); color: var(--high-fg); }
  .finding.tainted { border-left: 3px solid var(--high-fg); padding-left: 0.8rem; }
  ul.evidence li.evidence-unverified { color: var(--high-fg); }
  .evidence-problem { margin: 0.2rem 0; color: var(--high-fg); }
  .validation-list { padding-left: 1.2rem; }
  .validation-errors { color: var(--high-fg); }
  .validation-warnings { color: var(--medium-fg); }
  .summary-line { color: var(--muted); font-size: 0.95rem; margin: 0.15rem 0; }
</style>
</head>
<body>
<main>
  <h1>${escapeHtml(title)}</h1>
  <p class="summary-line">Assessed at: ${escapeHtml(runInfo.assessedAt)}</p>
  <p class="summary-line">Overall risk: <span class="badge ${riskClass(assessment.overallRisk)}">${
    RISK_LABEL[assessment.overallRisk] ?? assessment.overallRisk
  }</span></p>
  ${runInfo.commit ? `<p class="summary-line">Commit: <code>${escapeHtml(runInfo.commit)}</code></p>` : ""}
  ${
    runInfo.primaryLanguages.length > 0
      ? `<p class="summary-line">Primary languages: ${escapeHtml(runInfo.primaryLanguages.join(", "))}</p>`
      : ""
  }
  <p class="summary-line">Duration: ${escapeHtml(formatDuration(runInfo.durationMs))}</p>
  <p class="summary-line">Agent: ${escapeHtml(runInfo.agentName)}${runInfo.model ? ` (${escapeHtml(runInfo.model)})` : ""}</p>
  ${
    runInfo.repairRounds > 0
      ? `<p class="summary-line">Evidence repair rounds: ${runInfo.repairRounds}</p>`
      : ""
  }
  ${
    runInfo.usage?.totalCostUsd !== undefined
      ? `<p class="summary-line">Estimated cost: $${runInfo.usage.totalCostUsd.toFixed(4)}</p>`
      : ""
  }
  <p class="summary-line">Session: <code>${escapeHtml(runInfo.sessionId)}</code></p>

  <h2>Summary</h2>
  <p>${escapeHtml(assessment.summary)}</p>

  <h2>Findings by component</h2>
  ${componentsHtml}

  ${policyHtml}
  ${openQuestionsHtml}
  ${limitationsHtml}

  <h2>Validation</h2>
  <p>${escapeHtml(summarizeValidation(validation))}</p>
  ${unverifiedHtml}
  ${validationErrorsHtml}
  ${validationWarningsHtml}
</main>
</body>
</html>
`;
}
