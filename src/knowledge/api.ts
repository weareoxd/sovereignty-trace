import {
  loadKnowledgeDir,
  loadPolicyRecords,
  loadProviderRecords,
  type KnowledgeDoc,
  type PolicyDoc,
  type ProviderDoc,
} from "./store.js";
import type { ProviderEntry } from "./provider-schema.js";

/**
 * The read-only Sovereignty Graph knowledge API over the provider
 * (providers/) and policy (policies/) reference material.
 *
 * This material used to reach the coding agent only through tools it called
 * mid-session, which meant an assessment could simply never look something up.
 * It is split by audience now:
 *
 * - Policy text is pasted into the assessment's opening instructions in full
 *   ({@link buildPolicyBrief}), because judging alignment means reading it.
 * - Providers reach the agent as an identification index only
 *   ({@link buildProviderIndex}) — enough to name the right record, with
 *   residency deliberately withheld.
 * - Residency comes off the validated entry ({@link getProviderEntry}) after
 *   the agent names a record, and is read by code, not by the agent.
 *
 * Providers and policies are both authored as structured YAML and rendered
 * to text (see ./provider-schema.ts/./provider-render.ts and
 * ./policy-schema.ts/./policy-render.ts); only the separate, optional
 * policy-sources/ directory remains freehand Markdown.
 */

export interface ProviderRecord {
  id: string;
  title: string;
  content: string;
}

export interface PolicyRecord {
  id: string;
  title: string;
  content: string;
}

export interface PolicySourceRecord {
  id: string;
  title: string;
  content: string;
}

export interface KnowledgeSearchHit {
  id: string;
  title: string;
  /** Short excerpt showing why this record matched, for the caller to decide whether to fetch it in full. */
  snippet: string;
}

let providersCache: Promise<ProviderDoc[]> | undefined;
let policiesCache: Promise<PolicyDoc[]> | undefined;
let policySourcesCache: Promise<KnowledgeDoc[]> | undefined;

function loadProviders(): Promise<ProviderDoc[]> {
  return (providersCache ??= loadProviderRecords("providers"));
}

function loadPolicies(): Promise<PolicyDoc[]> {
  return (policiesCache ??= loadPolicyRecords("policies"));
}

function loadPolicySources(): Promise<KnowledgeDoc[]> {
  // Policy records in this deployment are self-contained; a separate
  // policy-sources/ directory is not shipped today. loadKnowledgeDir
  // returns [] for a missing directory, so getPolicySource degrades to
  // "not found" rather than throwing once (or if) one is added.
  return (policySourcesCache ??= loadKnowledgeDir("policy-sources"));
}

function searchDocs(docs: KnowledgeDoc[], query: string): KnowledgeSearchHit[] {
  const q = query.trim().toLowerCase();
  if (!q) return docs.map((doc) => ({ id: doc.id, title: doc.title, snippet: snippetOf(doc.content) }));

  const hits: KnowledgeSearchHit[] = [];
  for (const doc of docs) {
    const haystack = `${doc.id}\n${doc.title}\n${doc.content}`.toLowerCase();
    if (!haystack.includes(q)) continue;
    hits.push({ id: doc.id, title: doc.title, snippet: snippetOf(doc.content, q) });
  }
  return hits;
}

function snippetOf(content: string, query?: string): string {
  const lines = content.split("\n").map((line) => line.trim()).filter(Boolean);
  if (query) {
    const match = lines.find((line) => line.toLowerCase().includes(query));
    if (match) return match.slice(0, 240);
  }
  return (lines.find((line) => !line.startsWith("#")) ?? lines[0] ?? "").slice(0, 240);
}

/** Searches Sovereignty Graph's provider (cloud/AI vendor data-residency) knowledge by keyword. */
export async function searchProviders(query: string): Promise<KnowledgeSearchHit[]> {
  return searchDocs(await loadProviders(), query);
}

/** Fetches one provider record by id (as returned by {@link searchProviders}). */
export async function getProvider(id: string): Promise<ProviderRecord | undefined> {
  const docs = await loadProviders();
  return docs.find((doc) => doc.id === id);
}

/**
 * Fetches the validated entry behind a provider record, rather than the prose
 * {@link getProvider} renders. The assessment reads residency off this: the
 * rendered text is for people, the entry is for code.
 */
export async function getProviderEntry(id: string): Promise<ProviderEntry | undefined> {
  const docs = await loadProviders();
  return docs.find((doc) => doc.id === id)?.entry;
}

/** Every provider record id, sorted. The source of the assessment schema's provider enum. */
export async function listProviderIds(): Promise<string[]> {
  return (await loadProviders()).map((doc) => doc.id);
}

/**
 * A compact index of every provider record, for the assessment's opening
 * instructions: enough for the agent to tell which record matches the code in
 * front of it, and nothing more.
 *
 * Id and name alone are not enough — "Keycloak" appears only in bcgov-sso's
 * description, "S3-compatible" only in bcgov-coms's — so the description and
 * the access-path signatures are included. Residency is deliberately left out.
 * That is what the pipeline computes from the record after the agent picks it,
 * and showing it here would invite the agent to restate it from memory.
 */
export async function buildProviderIndex(): Promise<string> {
  const docs = await loadProviders();
  return docs.map((doc) => indexLine(doc.entry)).join("\n");
}

function indexLine(entry: ProviderEntry): string {
  const parts = [`${entry.id} | ${entry.name} | ${collapse(entry.description)}`];

  const signals = new Set<string>();
  for (const path of entry.access_paths) {
    const signatures = path.signatures;
    if (!signatures) continue;
    for (const domain of signatures.domains ?? []) signals.add(domain);
    for (const group of [signatures.packages, signatures.modules]) {
      for (const names of Object.values(group ?? {})) {
        for (const name of names ?? []) signals.add(name);
      }
    }
    for (const name of signatures.env_vars ?? []) signals.add(name);
    for (const name of signatures.terraform_providers ?? []) signals.add(name);
    for (const name of signatures.terraform_resource_prefixes ?? []) signals.add(name);
  }
  if (signals.size > 0) parts.push(`signals: ${[...signals].join(", ")}`);

  for (const hint of entry.what_to_look_for ?? []) parts.push(collapse(hint));

  return parts.join(" | ");
}

function collapse(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** Searches Sovereignty Graph's policy (BC Government data-residency/privacy) knowledge by keyword. */
export async function searchPolicies(query: string): Promise<KnowledgeSearchHit[]> {
  return searchDocs(await loadPolicies(), query);
}

/** Fetches one policy record by id (as returned by {@link searchPolicies}). */
export async function getPolicy(id: string): Promise<PolicyRecord | undefined> {
  const docs = await loadPolicies();
  return docs.find((doc) => doc.id === id);
}

/**
 * One answerable policy point: a `citable_sections` entry from a policy
 * document, flattened across documents so the assessment can enumerate every
 * rule that must be addressed without knowing which document holds it.
 */
export interface PolicyRule {
  /** The citable-section id, e.g. "personal-information-outside-canada". */
  id: string;
  /** The document it belongs to, e.g. "bc-foippa-overview". */
  policyId: string;
  title: string;
  guidance: string;
}

/**
 * Every policy point the assessment must answer, in document order.
 *
 * Runs used to answer 2, then 4, then 3, then 5, then 4 of these because
 * nothing said how many there were. Code enumerates them now and the agent
 * fills each one in.
 */
export async function listPolicyRules(): Promise<PolicyRule[]> {
  const docs = await loadPolicies();
  return docs.flatMap((doc) =>
    doc.document.citable_sections.map((section) => ({
      id: section.id,
      policyId: doc.id,
      title: section.title,
      guidance: section.guidance.replace(/\s+/g, " ").trim(),
    })),
  );
}

/**
 * The full text of every policy record, for the assessment's opening
 * instructions. These used to be fetched through tools mid-session; at 13.7 KB
 * the whole set costs less than the round trips did, and inlining removes the
 * failure mode where an assessment simply never looked one up.
 */
export async function buildPolicyBrief(): Promise<string> {
  const docs = await loadPolicies();
  return docs.map((doc) => doc.content.trim()).join("\n\n---\n\n");
}

/**
 * Fetches a policy's separate underlying source document, for policy
 * records that reference one. Returns undefined both when no
 * policy-sources/ directory is shipped and when the id isn't found in it —
 * callers cannot distinguish "not modeled" from "not found", which is
 * intentional: either way there is nothing further to retrieve.
 */
export async function getPolicySource(id: string): Promise<PolicySourceRecord | undefined> {
  const docs = await loadPolicySources();
  return docs.find((doc) => doc.id === id);
}
