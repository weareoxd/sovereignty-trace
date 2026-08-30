import { loadPromptFile } from "../prompts.js";
import type { EvidenceCheck } from "./validation.js";

/**
 * Builds the follow-up prompt for a repair round: the standing repair rules
 * plus the specific citations that failed, addressed by their path within the
 * assessment so the agent can find each one in the answer it just gave.
 *
 * The agent still holds the session it produced the assessment in, so it is
 * being asked to correct a reference it already looked at rather than to
 * re-investigate the repository.
 */
export async function buildEvidenceRepairPrompt(failures: EvidenceCheck[]): Promise<string> {
  const rules = await loadPromptFile("evidence-repair.md");

  const items = failures.map((failure) => {
    const location = failure.lines ? `${failure.file}:${failure.lines}` : failure.file;
    const suggestion = failure.suggestion
      ? ` The closest matching file in the repository is \`${failure.suggestion}\` (verify before using it).`
      : "";
    return `- \`${failure.path}\` cites \`${location}\`: ${failure.message ?? failure.verdict}${suggestion}`;
  });

  return [rules.trim(), "## Citations to fix", "", ...items].join("\n");
}
