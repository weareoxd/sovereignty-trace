import type { ResidencyStatus } from "./residency.js";
import type { DataClassification, RiskLevel } from "./schema.js";

/**
 * Stage 5 of the assessment: the risk score.
 *
 * This used to be prose in prompts/methodology.md and the agent applied it by
 * feel, which is why five runs of the same repository produced 0, 4, 1, 5 and 4
 * High findings. It is a pure function now. Two inputs come from the agent
 * (what kind of data, and whether this is the configuration actually in use);
 * the third is read off the provider record by ./residency.ts.
 *
 * There is no per-finding override. A score that reads wrong means this rule is
 * wrong, and the rule is what gets changed.
 */

export interface RiskInputs {
  classification: DataClassification;
  residency: ResidencyStatus;
  /**
   * Whether this is the default or currently-active configuration, as opposed
   * to an alternate adapter behind a flag or one documented as not yet enabled.
   */
  activePath: boolean;
}

export function scoreFinding({ classification, residency, activePath }: RiskInputs): RiskLevel {
  // The agent could not place the data at all. Saying so beats picking a tier.
  if (classification === "unclassified") return "unknown";

  if (classification === "none_identified") return "low";

  // Nothing left the deployment, so this finding raises no border question.
  // Where the deployment itself runs is assessed once, under the finding for
  // that infrastructure, rather than restated against every component inside it.
  if (residency === "self_hosted") return "low";

  if (residency === "canada") return "low";

  // Everything below is outside Canada, unknown, or uncovered by the registry.

  // The cloud policy prohibits Protected C in public cloud outright, so an
  // alternate code path is not a mitigation the way it is for the other tiers.
  if (classification === "protected_c") return "high";

  if (classification === "personal_information" || classification === "protected_b") {
    // "Unknown" and "outside Canada" score the same on purpose. 16 of 21
    // provider records state no storage residency at all, so treating unknown
    // as milder would score most of the registry as safe by default.
    return activePath ? "high" : "medium";
  }

  if (classification === "credentials_or_secrets") {
    return activePath ? "medium" : "low";
  }

  // operational
  if (residency === "outside_canada") return activePath ? "medium" : "low";
  return "low";
}

const ORDER: RiskLevel[] = ["low", "medium", "high"];

/**
 * The document's overall risk: the highest level any finding reached.
 *
 * Findings scored `unknown` are skipped rather than ranked, so one
 * unclassifiable finding cannot drag a document with real High findings down.
 * The result is `unknown` only when there is nothing else to go on: no
 * findings, or none that could be classified.
 */
export function rollUpRisk(levels: RiskLevel[]): RiskLevel {
  let best: RiskLevel | undefined;
  let bestRank = -1;
  for (const level of levels) {
    const rank = ORDER.indexOf(level);
    if (rank > bestRank) {
      bestRank = rank;
      best = level;
    }
  }
  return best ?? "unknown";
}
