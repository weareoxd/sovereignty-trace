import { readFile, stat } from "node:fs/promises";
import { isAbsolute, join, normalize, relative, resolve } from "node:path";
import { getPolicy, getPolicySource, getProvider } from "../knowledge/index.js";
import { mintEvidenceHandle, sliceLines } from "./evidence-handle.js";
import { suggestNearestPath } from "./nearest-path.js";
import { listRepositoryFiles } from "./repository-info.js";
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

/**
 * Outcome of checking one `evidence[]` entry against the repository.
 *
 * `absolute_path` and `lines_out_of_range` are citation hygiene: the finding
 * may well be sound. `file_missing` and `snippet_mismatch` mean the agent
 * cited something it cannot have read, which is the failure this whole check
 * exists to catch.
 */
export type EvidenceVerdict =
  | "verified"
  | "file_missing"
  | "outside_repository"
  | "absolute_path"
  | "unreadable"
  | "lines_out_of_range"
  | "snippet_mismatch"
  | "handle_mismatch";

export interface EvidenceCheck {
  /** Location within the assessment, e.g. `components[5].findings[0].evidence[2]`. */
  path: string;
  file: string;
  lines?: string;
  verdict: EvidenceVerdict;
  /** Why the citation failed. Absent when verified. */
  message?: string;
  /** Repository file this citation most likely meant, when one was found. */
  suggestion?: string;
}

/**
 * A finding (or policy-alignment entry) carrying at least one citation that
 * could not be verified. Findings are never dropped for this — a fabricated
 * citation does not make the finding false — so the report marks them
 * instead, and this is what it marks them from.
 */
export interface FindingTaint {
  /** Location within the assessment, e.g. `components[5].findings[0]`. */
  path: string;
  /** Finding name, or the policy reference label for a policy entry. */
  label: string;
  verified: number;
  total: number;
  failures: EvidenceCheck[];
}

export interface ValidationResult {
  valid: boolean;
  assessment?: SovereigntyAssessment;
  /**
   * Failures that discredit the assessment as a whole: schema violations and
   * provider/policy record ids that do not resolve. Evidence problems are not
   * here — they are attributed to the finding that made them, via
   * {@link ValidationResult.taintedFindings}.
   */
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
  /** Every citation checked, verified or not, in assessment order. */
  evidenceChecks: EvidenceCheck[];
  /** Only the findings with at least one unverified citation. */
  taintedFindings: FindingTaint[];
}

/**
 * Validates a coding agent's raw structured output against the sovereignty
 * assessment schema, then checks what it cites: every evidence `file` must
 * exist in the repository that was assessed and its `snippet` must actually
 * appear in that file, and every provider/policy record id it references must
 * exist in Sovereignty Graph's knowledge.
 *
 * Verifying the snippet, not just the path, is the point: a fabricated quote
 * pinned to a real file is the harder failure to spot by eye, because nothing
 * about the report looks wrong.
 *
 * This still does not verify that cited evidence *supports* the finding, only
 * that the agent did not cite something it could not have read.
 */
export async function validateAssessment(
  raw: unknown,
  options: { repositoryPath: string; files?: string[] },
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
      evidenceChecks: [],
      taintedFindings: [],
    };
  }

  const assessment = parsed.data;
  const errors: ValidationIssue[] = [];
  const warnings: ValidationIssue[] = [];
  const evidenceChecks: EvidenceCheck[] = [];
  const taintedFindings: FindingTaint[] = [];

  const repositoryPath = resolve(options.repositoryPath);
  const files = options.files ?? (await listRepositoryFiles(repositoryPath));

  for (const [componentIndex, component] of assessment.components.entries()) {
    for (const [findingIndex, finding] of component.findings.entries()) {
      const pathPrefix = `components[${componentIndex}].findings[${findingIndex}]`;
      const checks = await checkEvidence(finding.evidence, pathPrefix, repositoryPath, files);
      evidenceChecks.push(...checks);
      collectTaint(taintedFindings, pathPrefix, finding.name, checks);

      if (finding.providerReference) {
        await checkProviderReference(finding.providerReference, `${pathPrefix}.providerReference`, errors);
      }
    }
  }

  for (const [policyIndex, policy] of assessment.policyAlignment.entries()) {
    const pathPrefix = `policyAlignment[${policyIndex}]`;
    const ref = policy.policyReference;
    const checks = await checkEvidence(policy.evidence, pathPrefix, repositoryPath, files);
    evidenceChecks.push(...checks);
    collectTaint(taintedFindings, pathPrefix, ref.section ? `${ref.id}#${ref.section}` : ref.id, checks);

    await checkPolicyReference(ref, `${pathPrefix}.policyReference`, errors, warnings);
  }

  return {
    valid: errors.length === 0 && taintedFindings.length === 0,
    assessment,
    errors,
    warnings,
    evidenceChecks,
    taintedFindings,
  };
}

/** Every citation that did not come back `verified`. */
export function unverifiedEvidence(result: ValidationResult): EvidenceCheck[] {
  return result.evidenceChecks.filter((check) => check.verdict !== "verified");
}

/** Indexes checks by their assessment path, for renderers marking evidence in place. */
export function indexEvidenceChecks(checks: EvidenceCheck[]): Map<string, EvidenceCheck> {
  return new Map(checks.map((check) => [check.path, check]));
}

/** Indexes taint by finding path, for renderers marking findings in place. */
export function indexTaintedFindings(taints: FindingTaint[]): Map<string, FindingTaint> {
  return new Map(taints.map((taint) => [taint.path, taint]));
}

function collectTaint(
  into: FindingTaint[],
  path: string,
  label: string,
  checks: EvidenceCheck[],
): void {
  const failures = checks.filter((check) => check.verdict !== "verified");
  if (failures.length === 0) return;
  into.push({
    path,
    label,
    verified: checks.length - failures.length,
    total: checks.length,
    failures,
  });
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

/** Files larger than this are accepted on path alone; their snippet is not verified. */
const MAX_SNIPPET_CHECK_BYTES = 2 * 1024 * 1024;

async function checkEvidence(
  evidence: Evidence[],
  pathPrefix: string,
  repositoryPath: string,
  files: string[],
): Promise<EvidenceCheck[]> {
  const checks: EvidenceCheck[] = [];

  for (const [evidenceIndex, item] of evidence.entries()) {
    checks.push(
      await checkOneEvidence(item, `${pathPrefix}.evidence[${evidenceIndex}]`, repositoryPath, files),
    );
  }

  return checks;
}

async function checkOneEvidence(
  item: Evidence,
  path: string,
  repositoryPath: string,
  files: string[],
): Promise<EvidenceCheck> {
  const base = { path, file: item.file, lines: item.lines };

  if (isAbsolute(item.file)) {
    const asRelative = relative(repositoryPath, item.file);
    return {
      ...base,
      verdict: "absolute_path",
      message: `Evidence file "${item.file}" is an absolute path; expected a path relative to the repository root.`,
      suggestion: !asRelative.startsWith("..") && files.includes(asRelative) ? asRelative : undefined,
    };
  }

  const resolved = normalize(join(repositoryPath, item.file));
  if (relative(repositoryPath, resolved).startsWith("..")) {
    return {
      ...base,
      verdict: "outside_repository",
      message: `Evidence file "${item.file}" resolves outside the repository.`,
    };
  }

  let fileStat;
  try {
    fileStat = await stat(resolved);
  } catch {
    const suggestion = suggestNearestPath(item.file, files);
    return {
      ...base,
      verdict: "file_missing",
      message: `Evidence file "${item.file}" does not exist in the repository.`,
      suggestion,
    };
  }

  if (!fileStat.isFile()) {
    return {
      ...base,
      verdict: "unreadable",
      message: `Evidence file "${item.file}" is not a regular file.`,
    };
  }

  if (fileStat.size > MAX_SNIPPET_CHECK_BYTES) return { ...base, verdict: "verified" };

  let contents: string;
  try {
    contents = await readFile(resolved, "utf8");
  } catch (err) {
    return {
      ...base,
      verdict: "unreadable",
      message: `Evidence file "${item.file}" could not be read: ${(err as Error).message}`,
    };
  }

  const totalLines = contents.split("\n").length;
  const range = parseLineRange(item.lines);
  if (range && range.start > totalLines) {
    return {
      ...base,
      verdict: "lines_out_of_range",
      message: `Evidence cites lines ${item.lines} of "${item.file}", which has ${totalLines} line(s).`,
    };
  }

  // A handle re-derives only from the real text at the cited range, so a
  // matching one settles path, range, and content in a single check.
  if (item.evidenceId !== undefined && range) {
    const slice = sliceLines(contents, range.start, range.end);
    if (!slice || mintEvidenceHandle(item.file, slice) !== item.evidenceId) {
      return {
        ...base,
        verdict: "handle_mismatch",
        message: `Evidence id "${item.evidenceId}" does not match the contents of "${item.file}" at lines ${item.lines}. Re-read the range with sg_cite_evidence and copy back what it returns.`,
      };
    }
  }

  const snippet = normalizeForComparison(item.snippet);
  if (snippet.length === 0) {
    return {
      ...base,
      verdict: "snippet_mismatch",
      message: `Evidence for "${item.file}" provides no snippet; a file:line citation alone is not evidence.`,
    };
  }

  // Matched against the whole file rather than the cited range: the range is
  // frequently off by a line or two in ways that say nothing about whether the
  // agent read the file, and a false accusation of fabrication is worse than a
  // missed off-by-one.
  if (!normalizeForComparison(contents).includes(snippet)) {
    return {
      ...base,
      verdict: "snippet_mismatch",
      message: `Evidence snippet does not appear in "${item.file}". The quoted text was not found anywhere in the file.`,
    };
  }

  return { ...base, verdict: "verified" };
}

/**
 * Collapses whitespace so indentation and line-wrapping differences between
 * the agent's quote and the file don't read as fabrication. Blank lines are
 * dropped so a snippet quoted with different spacing still matches.
 */
function normalizeForComparison(text: string): string {
  return text
    .split("\n")
    .map((line) => line.trim().replace(/\s+/g, " "))
    .filter((line) => line.length > 0)
    .join("\n");
}

/**
 * Parses the schema's free-text `lines` field ("12", "12-18", "L12-L18").
 * Returns undefined for anything else, which skips the bounds check rather
 * than guessing at intent.
 */
function parseLineRange(lines: string | undefined): { start: number; end: number } | undefined {
  if (!lines) return undefined;

  const cleaned = lines.trim().replace(/[–—]/g, "-").replace(/[Ll]/g, "");
  const range = /^(\d+)\s*-\s*(\d+)$/.exec(cleaned);
  if (range) {
    const start = Number(range[1]);
    const end = Number(range[2]);
    return { start: Math.min(start, end), end: Math.max(start, end) };
  }

  const single = /^(\d+)$/.exec(cleaned);
  if (single) {
    const start = Number(single[1]);
    return { start, end: start };
  }

  return undefined;
}
