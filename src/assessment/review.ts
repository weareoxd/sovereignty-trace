import { SovereigntyAssessmentSchema } from "./schema.js";
import { unverifiedEvidence, validateAssessment } from "./validation.js";

/**
 * Verdict for one review round, shaped around swival's `--reviewer` contract:
 * exit 0 accepts the answer, exit 1 sends `feedback` back to the agent and
 * retries. Exit 2 means "the reviewer itself broke", and swival responds by
 * accepting the original answer, so nothing here ever produces it: a
 * validation failure must never be mistaken for a reviewer failure.
 */
export interface ReviewVerdict {
  accepted: boolean;
  feedback: string;
}

export interface ReviewOptions {
  repositoryPath: string;
  /** Repository-relative file listing, for nearest-path suggestions. */
  files?: string[];
  /** Reject findings whose citations don't verify, not just malformed documents. */
  requireVerifiedEvidence?: boolean;
}

const ACCEPTED: ReviewVerdict = { accepted: true, feedback: "" };

/**
 * Reviews one candidate assessment document the way `validateAssessment`
 * would, but while the agent can still fix it.
 *
 * This is the constraint that runtimes without schema-enforced output
 * otherwise lack. Rather than accepting whatever an agent produces and
 * repairing or tolerating it afterwards, the same schema and evidence rules
 * are applied as an accept/retry gate inside the agent's own loop, so a
 * malformed or unsupported answer is corrected at the point it is written.
 */
export async function reviewAssessmentOutput(
  raw: unknown,
  options: ReviewOptions,
): Promise<ReviewVerdict> {
  const parsed = SovereigntyAssessmentSchema.safeParse(raw);

  if (!parsed.success) {
    const problems = parsed.error.issues.map((issue) => {
      const path = issue.path.join(".") || "(root)";
      return `- \`${path}\`: ${issue.message}`;
    });

    return {
      accepted: false,
      feedback: [
        "Your assessment does not conform to the required JSON schema. Fix these and answer again:",
        "",
        ...problems,
        "",
        "Notes on the two mistakes that cause this most often:",
        "- Omit an optional field entirely when it does not apply. Do not set it to null.",
        "- Every value must have the type the schema states. Do not substitute null or an empty object for a missing string.",
        "",
        "Return the complete corrected assessment, not just the changed parts.",
      ].join("\n"),
    };
  }

  if (!options.requireVerifiedEvidence) return ACCEPTED;

  const validation = await validateAssessment(parsed.data, {
    repositoryPath: options.repositoryPath,
    files: options.files,
  });

  const problems = [
    ...unverifiedEvidence(validation).map((check) => {
      const suggestion = check.suggestion
        ? ` The closest matching file is \`${check.suggestion}\` (open it to confirm before citing it).`
        : "";
      return `- \`${check.path}\` cites \`${check.file}\`: ${check.message ?? check.verdict}${suggestion}`;
    }),
    ...validation.errors.map((error) => `- \`${error.path || "(root)"}\`: ${error.message}`),
  ];

  if (problems.length === 0) return ACCEPTED;

  return {
    accepted: false,
    feedback: [
      "Your assessment cites evidence or knowledge records that could not be verified. Fix these and answer again:",
      "",
      ...problems,
      "",
      "For each one: re-read the file with sg_cite_evidence and copy back exactly what it returns, or remove the citation.",
      "Remove any finding left with no evidence. Do not invent replacement evidence.",
      "",
      "Return the complete corrected assessment, not just the changed parts.",
    ].join("\n"),
  };
}
