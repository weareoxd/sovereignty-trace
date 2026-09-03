import type { ValidationResult } from "./assessment/validation.js";
import type { SovereigntyAssessment } from "./assessment/schema.js";
import { formatDuration, summarizeValidation } from "./report.js";
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

const CLASSIFICATION_LABEL: Record<string, string> = {
  personal_information: "Personal information",
  protected_b: "Protected B",
  protected_c: "Protected C",
  credentials_or_secrets: "Credentials or secrets",
  operational: "Operational",
  none_identified: "None identified",
  unclassified: "Unclassified",
};

function renderEvidence(
  evidence: SovereigntyAssessment["components"][number]["findings"][number]["evidence"],
): string {
  if (evidence.length === 0) return "";
  const items = evidence
    .map((e) => {
      const loc = e.lines ? `${e.file}:${e.lines}` : e.file;
      const note = e.note ? ` — ${escapeHtml(e.note)}` : "";
      const snippet = e.snippet
        ? `<pre class="snippet"><code>${escapeHtml(e.snippet)}</code></pre>`
        : "";
      return `<li><code>${escapeHtml(loc)}</code>${note}${snippet}</li>`;
    })
    .join("");
  return `<ul class="evidence">${items}</ul>`;
}

function renderFinding(
  finding: SovereigntyAssessment["components"][number]["findings"][number],
): string {
  const parts: string[] = [];
  parts.push(`<div class="finding">`);
  parts.push(
    `<div class="finding-header"><span class="finding-name">${escapeHtml(finding.name)}</span>` +
      `<span class="badges"><span class="badge ${riskClass(finding.riskLevel)}">${
        RISK_LABEL[finding.riskLevel] ?? finding.riskLevel
      }</span></span></div>`,
  );
  parts.push(`<p class="finding-description">${escapeHtml(finding.description)}</p>`);

  const ref = finding.providerReference;
  const meta: string[] = [
    `<li><strong>Provider:</strong> ${escapeHtml(finding.provider)} <code>${escapeHtml(ref.id)}</code></li>`,
    `<li><strong>Classification:</strong> ${escapeHtml(
      CLASSIFICATION_LABEL[finding.classification] ?? finding.classification,
    )}</li>`,
    `<li><strong>Path:</strong> ${
      finding.activePath ? "default or currently active" : "alternate, not the active path"
    }</li>`,
    `<li><strong>Destination jurisdiction:</strong> ${escapeHtml(finding.destinationJurisdiction)}</li>`,
  ];
  if (finding.crossesBorder !== undefined) {
    meta.push(`<li><strong>Crosses Canadian border:</strong> ${finding.crossesBorder ? "yes" : "no"}</li>`);
  }
  if (finding.dataCategories.length > 0) {
    meta.push(`<li><strong>Data categories:</strong> ${escapeHtml(finding.dataCategories.join(", "))}</li>`);
  }
  if (finding.alsoRelevantTo.length > 0) {
    const labels = finding.alsoRelevantTo.map((c) => CATEGORY_LABEL[c] ?? c).join(", ");
    meta.push(`<li><strong>Also relevant to:</strong> ${escapeHtml(labels)}</li>`);
  }
  if (finding.notes) meta.push(`<li><strong>Notes:</strong> ${escapeHtml(finding.notes)}</li>`);
  parts.push(`<ul class="finding-meta">${meta.join("")}</ul>`);

  const evidenceHtml = renderEvidence(finding.evidence);
  if (evidenceHtml) parts.push(evidenceHtml);

  parts.push(`</div>`);
  return parts.join("");
}

/**
 * Findings filed under another category that named this one too.
 *
 * Pointers, not copies. A managed search cluster is both a database and
 * infrastructure, and it used to be written out under both — as two findings
 * that could, and did, disagree about how the data was classified. It is one
 * finding now, reported in full in one place and pointed at from the other.
 */
function renderCrossReferences(
  refs: SovereigntyAssessment["components"][number]["alsoRelevantHere"],
): string {
  if (refs.length === 0) return "";
  const items = refs
    .map(
      (ref) =>
        `<li><span class="badge ${riskClass(ref.riskLevel)}">${
          RISK_LABEL[ref.riskLevel] ?? ref.riskLevel
        }</span> ${escapeHtml(ref.name)} — reported under ${escapeHtml(
          CATEGORY_LABEL[ref.category] ?? ref.category,
        )}</li>`,
    )
    .join("");
  return `<div class="cross-references"><p class="cross-references-heading">Also relevant here, reported in full elsewhere:</p><ul>${items}</ul></div>`;
}

/** Renders a sovereignty assessment (and its validation result) as a self-contained HTML report. */
export function renderHtmlReport(
  assessment: SovereigntyAssessment,
  validation: ValidationResult,
  runInfo: RunInfo,
): string {
  const title = `Sovereignty Assessment: ${runInfo.repositoryName}`;

  // Every category and policy point appears, whether or not it had anything to
  // report, so a reader can see what ground was covered. The empty ones are
  // muted rather than hidden: "nothing here" and "never looked" are different
  // answers, and both need to be visible without crowding the real findings.
  const componentsHtml = assessment.components
    .map((component) => {
      const empty = component.findings.length === 0 && component.alsoRelevantHere.length === 0;
      const findingsHtml =
        component.findings.length === 0
          ? `<p class="empty">No findings in this category.</p>`
          : component.findings.map(renderFinding).join("");
      return `
        <section class="component${empty ? " muted" : ""}">
          <h3>${escapeHtml(CATEGORY_LABEL[component.category] ?? component.category)}</h3>
          <p class="component-summary">${escapeHtml(component.summary)}</p>
          ${findingsHtml}
          ${renderCrossReferences(component.alsoRelevantHere)}
        </section>`;
    })
    .join("");

  const policyHtml =
    assessment.policyAlignment.length > 0
      ? `
        <section id="policy">
          <h2>Policy alignment</h2>
          ${assessment.policyAlignment
            .map((alignment) => {
              const ref = alignment.policyReference;
              const quiet = alignment.status === "unknown" || alignment.status === "not_applicable";
              return `
                <div class="finding${quiet ? " muted" : ""}">
                  <div class="finding-header">
                    <span class="finding-name">${escapeHtml(ref.title)}</span>
                    <span class="badges"><span class="badge ${policyStatusClass(alignment.status)}">${
                      POLICY_STATUS_LABEL[alignment.status] ?? alignment.status
                    }</span></span>
                  </div>
                  <p class="finding-description">${escapeHtml(alignment.explanation)}</p>
                  <ul class="finding-meta"><li><code>${escapeHtml(`${ref.id}#${ref.section}`)}</code></li></ul>
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
  .cross-references { border-top: 1px dashed var(--border); margin-top: 0.9rem; padding-top: 0.7rem; }
  .cross-references-heading { color: var(--muted); font-size: 0.92rem; margin: 0 0 0.35rem; }
  .cross-references ul { list-style: none; padding: 0; margin: 0; font-size: 0.92rem; color: var(--muted); }
  .cross-references li { margin: 0.25rem 0; display: flex; align-items: center; gap: 0.5rem; }
  .muted { opacity: 0.62; }
  .muted h3, .muted .finding-name { font-weight: 500; }
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
      ? `<p class="summary-line">Schema retries: ${runInfo.repairRounds}</p>`
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

  <h2>Coverage</h2>
  <p>${escapeHtml(summarizeValidation(validation))}</p>
  ${validationErrorsHtml}
  ${validationWarningsHtml}
</main>
</body>
</html>
`;
}
