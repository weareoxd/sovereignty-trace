import { buildPolicyBrief, buildProviderIndex, listPolicyRules } from "../knowledge/index.js";
import { loadPromptFile } from "../prompts.js";
import { COMPONENT_CATEGORIES } from "./schema.js";

export interface AssessmentInstructionsInput {
  /** Absolute path to the repository being assessed (informational; the agent's cwd is set separately). */
  repositoryPath: string;
  /** Languages already detected by file extension, most common first. */
  primaryLanguages?: string[];
  /** Total number of files already counted in the repository. */
  fileCount?: number;
  /** Patterns from the repository's own `.gitignore`, if any. */
  ignoredPatterns?: string[];
}

/**
 * Builds the opening instructions for one assessment session.
 *
 * Provider and policy material used to be withheld here and fetched through
 * tools mid-session. It is included now. The policy text is 12.3 KB and the
 * provider index 13.9 KB, which costs less than the tool round trips did
 * and removes the failure mode where a session simply never looked something
 * up: runs answered 2, then 4, then 3, then 5, then 4 of the same six policy
 * rules.
 *
 * The provider index carries only what identifies a record. Residency is left
 * out on purpose — the pipeline reads that off the record after the agent picks
 * one (see ./residency.ts), and putting it here would invite the agent to
 * restate it from memory instead.
 *
 * Order matters, and not for readability. Reference material the agent consults
 * while investigating goes first; the lists it must pick values *from* go last,
 * as close as possible to the schema asking for them. ../agents/swival.ts
 * appends the JSON schema after these instructions, so "last here" means
 * "adjacent to the question".
 *
 * This is the same lesson as the read-only instruction in that adapter, which
 * a local model ignored mid-prompt and obeyed when moved to the end. With the
 * provider index sitting 30 KB from the end, a run on a small local model
 * answered `no_matching_record` nine times, including for CHES and for
 * S3-compatible storage, both of which have records it had matched correctly
 * in an earlier run.
 */
export async function buildAssessmentInstructions(
  input: AssessmentInstructionsInput,
): Promise<string> {
  const [role, methodology, providerIndex, policyBrief, rules] = await Promise.all([
    loadPromptFile("role.md"),
    loadPromptFile("methodology.md"),
    buildProviderIndex(),
    buildPolicyBrief(),
    listPolicyRules(),
  ]);

  const sections = [
    role.trim(),
    `Repository under assessment: ${input.repositoryPath}`,
    buildRepositoryFactsSection(input),
    methodology.trim(),
    ["# Policy reference material", "", policyBrief].join("\n"),
    buildPolicyRuleChecklist(rules),
    buildCategoryChecklist(),
    buildProviderSection(providerIndex),
  ].filter((section): section is string => section.length > 0);

  return sections.join("\n\n---\n\n");
}

function buildCategoryChecklist(): string {
  return [
    "# Component categories",
    "",
    "Report on every one of these, in this order. A category with nothing to",
    "report still needs an entry saying so; leaving it out is not the same",
    "answer as finding nothing.",
    "",
    ...COMPONENT_CATEGORIES.map((category) => `- \`${category}\``),
  ].join("\n");
}

function buildProviderSection(index: string): string {
  return [
    "# Provider records",
    "",
    "Every finding names one of these ids in `providerId`. Match on what the",
    "code shows — the domain it calls, the package it imports, the service it",
    "names — not on the vendor's marketing name.",
    "",
    "Two ids are not records:",
    "",
    "- `no_matching_record` when a real third party receives the data and",
    "  nothing here covers it. Say which vendor in the finding's notes.",
    "- `self_hosted_or_no_third_party` when the component runs inside the",
    "  deployment's own infrastructure — an in-cluster cache, database, or",
    "  scanner. Where that infrastructure itself runs is a separate finding",
    "  under `infrastructure`, with its own record.",
    "",
    "An address with no public hostname is in-cluster by definition, so it is",
    "`self_hosted_or_no_third_party` and not `no_matching_record`. That covers a",
    "`.svc.cluster.local` name, a bare service name like `redis` or `loki`,",
    "`localhost`, and any plain-HTTP internal port. Reach for",
    "`no_matching_record` only when the data actually leaves for a public host.",
    "",
    "Do not report where a provider stores or processes data. That is read off",
    "the record for you once you have named it.",
    "",
    "```",
    index,
    "```",
  ].join("\n");
}

function buildPolicyRuleChecklist(rules: { id: string; title: string; guidance: string }[]): string {
  return [
    "# Policy points",
    "",
    "Answer every one of these in `policyAlignment`, using its id in `ruleId`.",
    "The full text of each is in the policy reference material below.",
    "",
    ...rules.map((rule) => `- \`${rule.id}\` — ${rule.title}. ${rule.guidance}`),
  ].join("\n");
}

/**
 * Facts already gathered deterministically before the session starts, so
 * the agent doesn't have to spend its own orienting tool calls
 * rediscovering them. Kept short and factual — no file listing.
 */
function buildRepositoryFactsSection(input: AssessmentInstructionsInput): string {
  const lines: string[] = [];

  if (input.primaryLanguages && input.primaryLanguages.length > 0) {
    lines.push(`Primary language(s) detected: ${input.primaryLanguages.join(", ")}.`);
  }
  if (input.fileCount !== undefined) {
    lines.push(`Files tracked in the repository: ${input.fileCount}.`);
  }
  if (input.ignoredPatterns && input.ignoredPatterns.length > 0) {
    lines.push(
      `This repository's .gitignore excludes: ${input.ignoredPatterns.join(", ")}. ` +
        "Treat these as noise (dependency/build artifacts) unless a specific finding " +
        "requires inspecting them, and prefer targeted Glob/Grep patterns over broad " +
        "recursive Bash scans for initial discovery.",
    );
  }

  if (lines.length === 0) return "";
  return ["Repository facts (already gathered — no need to rediscover):", ...lines].join("\n");
}
