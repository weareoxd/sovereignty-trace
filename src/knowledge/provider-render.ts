import type { AccessPath, ProviderEntry, RegionFact } from "./provider-schema.js";

/**
 * Renders a validated provider entry into the prose text sg_get_provider
 * returns to the coding agent. The tool contract doesn't change — it's
 * still one text blob per provider — but the text is now generated from
 * fixed fields instead of freehand-written each time, so the same facts
 * (region status, evidence, verification date) show up in the same place
 * and the same words on every entry.
 */
export function renderProvider(entry: ProviderEntry): string {
  const lines: string[] = [];

  lines.push(`# ${entry.name}`, "");
  lines.push(renderStatusLine(entry), "");
  lines.push(entry.description.trim(), "");

  lines.push("## Data residency model", "");
  entry.access_paths.forEach((path, i) => {
    if (i > 0) lines.push("");
    lines.push(...renderAccessPath(path, entry.access_paths.length > 1));
  });

  if (entry.what_to_look_for?.length) {
    lines.push("", "## What to look for in a repository", "");
    for (const item of entry.what_to_look_for) lines.push(`- ${item}`);
  }

  if (entry.notes) {
    lines.push("", "## Notes for findings", "");
    lines.push(entry.notes.trim());
  }

  const orgLines = renderOrganization(entry);
  if (orgLines.length) lines.push("", "## Legal and organizational", "", ...orgLines);

  const topEvidence = renderEvidence(entry.evidence);
  if (topEvidence.length) lines.push("", "## Sources", "", ...topEvidence);

  return lines.join("\n").trim() + "\n";
}

function renderStatusLine(entry: ProviderEntry): string {
  const lastVerified = entry.metadata?.last_verified;
  if (entry.status === "FICTIONAL") {
    return "**FICTIONAL** — an invented service used by examples and tests. Not a claim about a real organization.";
  }
  const checked = lastVerified ? `Last checked ${lastVerified}.` : "No last-checked date recorded — treat as unverified.";
  if (entry.status === "VERIFIED") {
    return `**VERIFIED** — every data-residency claim below carries source evidence and a checked date. ${checked}`;
  }
  return `**UNVERIFIED** — a real service whose facts have not been independently validated for this deployment. ${checked} Validate against current contracts and documentation before relying on this for a sovereignty conclusion.`;
}

function renderAccessPath(path: AccessPath, showHeading: boolean): string[] {
  const lines: string[] = [];
  if (showHeading) lines.push(`### ${path.label} (\`${path.key}\`)`, "");

  const recognizeBy = summarizeSignatures(path.signatures);
  if (recognizeBy) lines.push(`**Recognize by:** ${recognizeBy}`, "");

  lines.push("**Data residency:**");
  const dr = path.data_residency;
  lines.push(`- Customer-configurable: ${renderBoolOrUnknown(dr.customer_configurable)}`);
  const configuredRegionReason = dr.configured_region_reason.trim();
  lines.push(
    dr.configured_region_derivable_from_repository
      ? `- The actual configured region can be determined from repository evidence: ${configuredRegionReason}`
      : `- The actual configured region cannot be determined from repository evidence alone: ${configuredRegionReason}`,
  );
  if (dr.storage_regions) lines.push(renderRegionFact("Storage region", dr.storage_regions));
  if (dr.processing_regions) lines.push(renderRegionFact("Processing region", dr.processing_regions));
  if (dr.support_access_regions) lines.push(renderRegionFact("Support access region", dr.support_access_regions));
  if (dr.telemetry_processing_regions) lines.push(renderRegionFact("Telemetry region", dr.telemetry_processing_regions));

  if (path.notes) lines.push("", path.notes.trim());

  if (path.related_providers?.length) {
    lines.push("", `Related provider record(s): ${path.related_providers.join(", ")} — check their region evidence for the actual processing location.`);
  }

  const pathEvidence = renderEvidence(path.evidence);
  if (pathEvidence.length) lines.push("", "Sources:", ...pathEvidence);

  return lines;
}

function renderBoolOrUnknown(value: boolean | "unknown"): string {
  if (value === "unknown") return "unknown";
  return value ? "yes" : "no";
}

function renderRegionFact(label: string, fact: RegionFact): string {
  if (fact.status === "known") {
    const reason = fact.reason ? ` — ${fact.reason.trim()}` : "";
    return `- ${label}: ${fact.values.join(", ")}${reason}`;
  }
  if (fact.status === "not_applicable") {
    return `- ${label}: not applicable — ${fact.reason.trim()}`;
  }
  return `- ${label}: unknown — ${fact.reason.trim()}`;
}

function summarizeSignatures(signatures: AccessPath["signatures"]): string | undefined {
  if (!signatures) return undefined;
  const parts: string[] = [];
  if (signatures.domains?.length) parts.push(`domain(s) ${signatures.domains.map((d) => `\`${d}\``).join(", ")}`);
  const pkgParts: string[] = [];
  if (signatures.packages?.javascript?.length) pkgParts.push(`${signatures.packages.javascript.map((p) => `\`${p}\``).join(", ")} (JS)`);
  if (signatures.packages?.python?.length) pkgParts.push(`${signatures.packages.python.map((p) => `\`${p}\``).join(", ")} (Python)`);
  if (pkgParts.length) parts.push(`package(s) ${pkgParts.join(", ")}`);
  if (signatures.env_vars?.length) parts.push(`env var(s) ${signatures.env_vars.map((e) => `\`${e}\``).join(", ")}`);
  if (signatures.terraform_providers?.length) {
    parts.push(`Terraform provider(s) ${signatures.terraform_providers.map((p) => `\`${p}\``).join(", ")}`);
  }
  if (signatures.terraform_resource_prefixes?.length) {
    parts.push(`Terraform resource prefix(es) ${signatures.terraform_resource_prefixes.map((p) => `\`${p}\``).join(", ")}`);
  }
  return parts.length ? parts.join("; ") : undefined;
}

function renderOrganization(entry: ProviderEntry): string[] {
  const lines: string[] = [];
  if (entry.headquarters_country) lines.push(`- Headquarters: ${entry.headquarters_country}`);
  for (const le of entry.legal_entities ?? []) lines.push(`- ${le.role.replace(/_/g, " ")}: ${le.name} (${le.jurisdiction})`);
  if (entry.subprocessors?.length) lines.push(`- Subprocessors: ${entry.subprocessors.join(", ")}`);
  return lines;
}

function renderEvidence(evidence: Array<{ url: string; checked: string }> | undefined): string[] {
  if (!evidence?.length) return [];
  return evidence.map((e) => `- ${e.url} (checked ${e.checked})`);
}
