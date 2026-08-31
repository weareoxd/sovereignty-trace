import type { Authority, CitableSection, PolicyDocument } from "./policy-schema.js";

/**
 * Renders a validated policy document into the prose text the coding agent
 * reads. Mirrors ./provider-render.ts: the same facts (verification status,
 * citation, checked date) show up in the same place and the same words on
 * every record instead of being written freehand each time.
 *
 * Unlike the provider equivalent, this text does reach the agent — the whole
 * set is pasted into the assessment's opening instructions (see
 * ../assessment/methodology.ts), because judging alignment means reading it.
 */
export function renderPolicy(doc: PolicyDocument): string {
  const lines: string[] = [];

  lines.push(`# ${doc.title}`, "");
  lines.push(renderStatusLine(doc), "");
  lines.push(doc.summary.trim(), "");

  for (const section of doc.sections) {
    lines.push(`## ${section.heading}`, "", section.body.trim(), "");
  }

  lines.push("## Findings this document supports", "");
  lines.push(
    `When citing this document, set \`policyReference.id\` to \`${doc.id}\` and \`policyReference.section\` to one of:`,
    "",
  );
  for (const section of doc.citable_sections) lines.push(...renderCitableSection(section));

  if (doc.out_of_scope?.length) {
    lines.push("", "## What this document does not cover", "");
    for (const item of doc.out_of_scope) lines.push(`- ${item}`);
    lines.push("", "Flag these as open questions rather than guessing at them.");
  }

  if (doc.related_policies?.length) {
    lines.push("", "## Related policy records", "");
    for (const id of doc.related_policies) lines.push(`- ${id}`);
  }

  return lines.join("\n").trim() + "\n";
}

function renderStatusLine(doc: PolicyDocument): string {
  const jurisdiction = doc.jurisdiction ? ` Jurisdiction: ${doc.jurisdiction}.` : "";
  if (doc.status === "VERIFIED") {
    return `**VERIFIED** — every citation below has had independent legal/policy review by the adopting organization.${jurisdiction}`;
  }
  return `**UNVERIFIED** — a starting reference, not a legal source. Verify anything consequential against the authoritative source before relying on it.${jurisdiction}`;
}

function renderCitableSection(section: CitableSection): string[] {
  const lines: string[] = [`- \`${section.id}\` — ${section.title}: ${section.guidance.trim()}`];
  if (section.authority) lines.push(...renderAuthority(section.authority).map((l) => `  ${l}`));
  return lines;
}

function renderAuthority(authority: Authority): string[] {
  const lines: string[] = [];
  const ref = authority.reference ? ` (${authority.reference})` : "";
  lines.push(`Authority: ${authority.source.trim()}${ref}`);
  const checked = authority.checked ? `checked ${authority.checked}` : "no checked date recorded — treat as unverified";
  lines.push(`Status: ${checked}.`);
  if (authority.note) lines.push(`Note: ${authority.note.trim()}`);
  return lines;
}
