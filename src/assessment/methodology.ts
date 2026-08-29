import { loadPromptFile } from "../prompts.js";

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
 * Builds the opening instructions given to the coding agent for one
 * assessment session: role and assessment methodology only. Provider and
 * policy reference material is deliberately not included here — it is
 * on-demand knowledge the agent queries via the SG knowledge tools while it
 * investigates (see ../knowledge/api.ts and the runtime adapter that
 * exposes it, e.g. ../agents/sg-tools.ts).
 */
export async function buildAssessmentInstructions(
  input: AssessmentInstructionsInput,
): Promise<string> {
  const [role, methodology] = await Promise.all([
    loadPromptFile("role.md"),
    loadPromptFile("methodology.md"),
  ]);

  const sections = [
    role.trim(),
    `Repository under assessment: ${input.repositoryPath}`,
    buildRepositoryFactsSection(input),
    methodology.trim(),
  ].filter((section): section is string => section.length > 0);

  return sections.join("\n\n---\n\n");
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
