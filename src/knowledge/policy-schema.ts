import { z } from "zod";

/**
 * Structured shape for a policy document (policies/*.yaml). Mirrors
 * ./provider-schema.ts: this is the source of truth an entry's author fills
 * in, src/knowledge/policy-render.ts turns a validated entry into the prose
 * text sg_get_policy actually returns, and the tool contract doesn't change
 * — still one text blob per policy record.
 *
 * A policy document is not evaluated by any code — unlike a rule engine, SG
 * gives this text to the coding agent as grounding and lets the agent judge
 * alignment itself (see policyAlignment in ../assessment/schema.ts). What
 * structure buys here is the same thing it bought providers: every citable
 * claim carries a verification status and a checked date instead of that
 * being buried in prose, and `citable_sections[].id` becomes an enumerable,
 * checkable set instead of a freehand Markdown anchor convention.
 */

const authoritySchema = z.object({
  // legislation - a specific act/regulation. government_policy - a core
  // policy manual, OCIO standard, or similar published direction that isn't
  // itself law. practice - no citable source; this section exists for a
  // structural reason (e.g. "no context was declared"), not a legal one.
  type: z.enum(["legislation", "government_policy", "practice"]),
  source: z.string().describe("What this cites, in words a reader can act on without following the reference."),
  reference: z.string().optional().describe('Short citation, e.g. "FOIPPA s. 33.1".'),
  checked: z.string().optional().describe("Date this citation was last confirmed against the authoritative source. Omit rather than guess."),
  note: z.string().optional().describe("Caveats about the citation itself — what was and wasn't verified, what might have changed since."),
});

const proseSectionSchema = z.object({
  heading: z.string(),
  body: z.string(),
});

const citableSectionSchema = z.object({
  // Stable slug within this document. This is the value a policyAlignment
  // finding's `policyReference.section` cites — see PolicyReferenceSchema in
  // ../assessment/schema.ts.
  id: z.string(),
  title: z.string(),
  // What kind of finding this section supports, and how to characterize it
  // (aligned/at_risk/violated/...). This is guidance for the citing agent,
  // not a rule the code evaluates.
  guidance: z.string(),
  authority: authoritySchema.optional(),
});

export const policyDocumentSchema = z.object({
  id: z.string(),
  title: z.string(),

  // VERIFIED - every citable_sections[].authority below carries a checked
  // date and has had independent legal/policy review by the adopting
  // organization. UNVERIFIED - a real framework whose citations have not had
  // that review; treat as a starting reference, not a legal source.
  status: z.enum(["VERIFIED", "UNVERIFIED"]),

  jurisdiction: z.string().optional().describe('e.g. "British Columbia, Canada".'),

  summary: z.string().describe("One or two paragraphs of background context, shown before any section headings."),

  // Ordered background/context sections, rendered as-is. Not individually
  // citable — for that, use citable_sections below.
  sections: z.array(proseSectionSchema).default([]),

  // At least one. What "Findings this document supports" enumerated in the
  // old freehand Markdown; now each entry's `id` is validated against the
  // filename-derived record at load time instead of being a convention.
  citable_sections: z.array(citableSectionSchema).min(1),

  out_of_scope: z.array(z.string()).optional().describe("What this document deliberately does not cover. Flag as open questions, not guesses."),

  related_policies: z.array(z.string()).optional().describe("Other policy record ids (filenames without .yaml) this document cross-references."),

  metadata: z
    .object({
      last_reviewed: z.string().optional(),
      maintainer: z.string().optional(),
    })
    .optional(),
});

export type PolicyDocument = z.infer<typeof policyDocumentSchema>;
export type CitableSection = PolicyDocument["citable_sections"][number];
export type Authority = z.infer<typeof authoritySchema>;
