import { buildNarrowedDraftSchema } from "./schema.js";

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

const ACCEPTED: ReviewVerdict = { accepted: true, feedback: "" };

/**
 * Checks a candidate answer while the agent can still fix it.
 *
 * This is the constraint that runtimes without schema-enforced output
 * otherwise lack: rather than accepting whatever comes back and repairing it
 * afterwards, the same schema is applied as an accept/retry gate inside the
 * agent's own loop.
 *
 * It checks the shape and nothing else. Evidence used to be checked here too,
 * because the agent wrote the snippets; it doesn't any more, so there is
 * nothing to catch — a citation that doesn't resolve is dropped downstream in
 * ./hydrate-evidence.ts without another round trip.
 *
 * The one check worth having in-loop is the provider id, because the schema
 * narrows it to the records that exist. An invented id gets corrected here,
 * with the list still in front of the agent.
 */
export async function reviewAssessmentOutput(raw: unknown): Promise<ReviewVerdict> {
  const schema = await buildNarrowedDraftSchema();
  const parsed = schema.safeParse(raw);
  if (parsed.success) return ACCEPTED;

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
      "Notes on the mistakes that cause this most often:",
      "- Omit an optional field entirely when it does not apply. Do not set it to null.",
      "- Every value must have the type the schema states. Do not substitute null or an empty object for a missing string.",
      "- `providerId` and `ruleId` must be values from the lists in your instructions, copied exactly. Do not shorten or reformat an id.",
      "",
      "Return the complete corrected assessment, not just the changed parts.",
    ].join("\n"),
  };
}
