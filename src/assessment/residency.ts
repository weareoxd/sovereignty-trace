import { getProviderEntry } from "../knowledge/index.js";
import type { ProviderEntry, RegionFact } from "../knowledge/index.js";

/**
 * Stage 4 of the assessment: turn the provider record id the agent chose into
 * the residency facts the risk score is computed from.
 *
 * This is a lookup, not a match. The agent picks from an enum built out of the
 * record ids on disk (see ../knowledge/api.ts `listProviderIds`), so by the
 * time this runs the id is either a real record or one of the two sentinels
 * below. Nothing here searches, guesses, or reads prose.
 */

/** Sentinel the agent picks when no record in the registry covers the vendor. */
export const NO_MATCHING_RECORD = "no_matching_record";

/**
 * Sentinel for a component that isn't a third party at all — a cache, a
 * database, or a scanner running inside the deployment's own infrastructure.
 * Data reaching it hasn't left the deployment, so the border question belongs
 * to the infrastructure the deployment runs on, which is assessed once under
 * its own finding, rather than being restated against every component inside it.
 */
export const SELF_HOSTED = "self_hosted_or_no_third_party";

export type ResidencyStatus =
  | "canada"
  | "outside_canada"
  | "unknown"
  | "no_record"
  | "self_hosted";

export interface ResidencyFacts {
  status: ResidencyStatus;
  /** Whether a record for this id exists in SG provider knowledge. */
  providerAvailable: boolean;
  /** Human-readable destination, e.g. "Canada" or "European Union, United States". */
  destinationJurisdiction: string;
  /** Undefined when the record doesn't establish it either way. */
  crossesBorder?: boolean;
  /** The published regions this was derived from, when the record states any. */
  regions?: string[];
}

export async function resolveResidency(providerId: string): Promise<ResidencyFacts> {
  if (providerId === SELF_HOSTED) {
    return {
      status: "self_hosted",
      providerAvailable: false,
      destinationJurisdiction: "within the deployment's own infrastructure",
      crossesBorder: false,
    };
  }

  if (providerId === NO_MATCHING_RECORD) {
    return {
      status: "no_record",
      providerAvailable: false,
      destinationJurisdiction: "unknown (no SG provider record)",
    };
  }

  const entry = await getProviderEntry(providerId);
  if (!entry) {
    // The enum is generated from the same records this reads, so this means
    // the registry changed under a resumed session rather than a bad guess.
    return {
      status: "no_record",
      providerAvailable: false,
      destinationJurisdiction: "unknown (no SG provider record)",
    };
  }

  return fromEntry(entry);
}

function fromEntry(entry: ProviderEntry): ResidencyFacts {
  const regions = publishedRegions(entry);

  if (regions.length === 0) {
    return {
      status: "unknown",
      providerAvailable: true,
      destinationJurisdiction: "unknown (record states no residency)",
    };
  }

  const allCanadian = regions.every(isCanada);
  return {
    status: allCanadian ? "canada" : "outside_canada",
    providerAvailable: true,
    destinationJurisdiction: regions.join(", "),
    crossesBorder: !allCanadian,
    regions,
  };
}

/**
 * Storage and processing regions across every access path, unioned.
 *
 * Unioning is deliberate. An entry with several access paths models one vendor
 * reachable through backends with different residency (Claude direct vs. via
 * Bedrock), and the agent picks the vendor, not the path. Taking the union
 * means a vendor with any non-Canadian path reads as non-Canadian, which is the
 * conservative direction for a sovereignty assessment.
 *
 * support_access_regions and telemetry_processing_regions are left out: they
 * describe who can reach the data, not where it lives, and folding them in here
 * would silently turn a support question into a storage claim.
 */
function publishedRegions(entry: ProviderEntry): string[] {
  const found = new Set<string>();
  for (const path of entry.access_paths) {
    for (const fact of [path.data_residency.storage_regions, path.data_residency.processing_regions]) {
      for (const value of knownValues(fact)) found.add(value);
    }
  }
  return [...found];
}

function knownValues(fact: RegionFact | undefined): string[] {
  return fact?.status === "known" ? fact.values : [];
}

function isCanada(region: string): boolean {
  return /^(canada|ca)$/i.test(region.trim());
}
