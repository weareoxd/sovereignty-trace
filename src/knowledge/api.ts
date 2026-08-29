import { loadKnowledgeDir, loadPolicyRecords, loadProviderRecords, type KnowledgeDoc } from "./store.js";

/**
 * The read-only Sovereignty Graph knowledge API: search/lookup over the
 * provider (providers/) and policy (policies/) reference material. This is
 * the only way that material reaches a coding agent — it is deliberately
 * not included in any assessment's opening instructions (see
 * ../assessment/methodology.ts). A runtime adapter (Claude Code, and
 * eventually others) exposes these functions as callable tools; this module
 * has no knowledge of any particular runtime.
 *
 * Providers and policies are both authored as structured YAML and rendered
 * to text (see ./provider-schema.ts/./provider-render.ts and
 * ./policy-schema.ts/./policy-render.ts); only the separate, optional
 * policy-sources/ directory remains freehand Markdown. All three loaders
 * return the same {id, title, content} shape, so everything below this
 * point is format-agnostic.
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

let providersCache: Promise<KnowledgeDoc[]> | undefined;
let policiesCache: Promise<KnowledgeDoc[]> | undefined;
let policySourcesCache: Promise<KnowledgeDoc[]> | undefined;

function loadProviders(): Promise<KnowledgeDoc[]> {
  return (providersCache ??= loadProviderRecords("providers"));
}

function loadPolicies(): Promise<KnowledgeDoc[]> {
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
