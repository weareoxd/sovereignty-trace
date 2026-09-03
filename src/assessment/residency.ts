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
 *
 * Two sources feed it, in order. A record with published storage/processing
 * regions settles the question by itself. A record without them — every
 * customer-configurable cloud, where there is no fixed list to publish — falls
 * back to the region the assessment read out of the repository, matched
 * against that record's own `canadian_regions`. The agent supplies a region
 * string it saw in the code; this decides what the string means. Residency
 * stays a fact the code derives, not one the agent asserts.
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
  /**
   * The repository-configured region this was derived from, when the record
   * published no regions of its own and the finding supplied one.
   */
  configuredRegion?: string;
}

export async function resolveResidency(
  providerId: string,
  /**
   * The region this deployment configures, as read out of the repository by
   * the assessment (e.g. "ca-central-1"). Used only when the record publishes
   * no regions and declares the configured region derivable.
   */
  configuredRegion?: string,
): Promise<ResidencyFacts> {
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

  return fromEntry(entry, configuredRegion);
}

function fromEntry(entry: ProviderEntry, configuredRegion?: string): ResidencyFacts {
  const regions = publishedRegions(entry);

  if (regions.length === 0) {
    return fromConfiguredRegion(entry, configuredRegion);
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
 * The fallback for records that publish no regions: read the region this
 * repository configures.
 *
 * Three things all have to hold before a region moves the score, and each
 * missing one leaves the answer at unknown rather than guessing:
 *
 * 1. The assessment found a region in the repository.
 * 2. The record declares the configured region derivable from a repository,
 *    so a region string is evidence about this provider rather than an
 *    unrelated value that happens to look like one.
 * 3. The record lists its own Canadian region identifiers, so there is
 *    something to compare against. Without them the region is still reported
 *    in the prose — it just doesn't decide anything.
 *
 * A region that matches none of the listed Canadian ones reads as outside
 * Canada. That is the conservative direction, and it is also the honest one:
 * for a record that named its Canadian regions, "not one of them" is a real
 * answer rather than an absence of one.
 */
function fromConfiguredRegion(entry: ProviderEntry, configuredRegion?: string): ResidencyFacts {
  const region = configuredRegion?.trim();
  const canadian = canadianRegions(entry);

  if (!region || !derivableFromRepository(entry) || canadian.length === 0) {
    return {
      status: "unknown",
      providerAvailable: true,
      destinationJurisdiction: region
        ? `unknown (repository configures ${region}; record does not establish where that is)`
        : "unknown (record states no residency)",
      configuredRegion: region,
    };
  }

  const inCanada = canadian.some((value) => sameRegion(value, region));
  return {
    status: inCanada ? "canada" : "outside_canada",
    providerAvailable: true,
    destinationJurisdiction: inCanada
      ? `Canada (${region}, as configured in the repository)`
      : `outside Canada (${region}, as configured in the repository)`,
    crossesBorder: !inCanada,
    configuredRegion: region,
  };
}

/** True when any access path says a repository can settle the configured region. */
function derivableFromRepository(entry: ProviderEntry): boolean {
  return entry.access_paths.some(
    (path) => path.data_residency.configured_region_derivable_from_repository,
  );
}

function canadianRegions(entry: ProviderEntry): string[] {
  const found = new Set<string>();
  for (const path of entry.access_paths) {
    if (!path.data_residency.configured_region_derivable_from_repository) continue;
    for (const value of path.data_residency.canadian_regions ?? []) found.add(value);
  }
  return [...found];
}

function sameRegion(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
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
