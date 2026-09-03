import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { packageRoot } from "../paths.js";
import { policyDocumentSchema, type PolicyDocument } from "./policy-schema.js";
import { renderPolicy } from "./policy-render.js";
import { providerEntrySchema, type ProviderEntry } from "./provider-schema.js";
import { renderProvider } from "./provider-render.js";

/**
 * Loads the Markdown documents backing one Sovereignty Trace knowledge
 * directory (policy-sources/, ...). Each file becomes one record, keyed by
 * its filename (without extension). `README.md` is skipped — it documents
 * the directory, it isn't a record.
 *
 * A missing directory (e.g. an optional policy-sources/ directory that
 * hasn't been populated yet) yields an empty list rather than throwing, so
 * callers can treat "not modeled yet" the same as "no matches".
 */

export interface KnowledgeDoc {
  /** Stable id derived from the filename, e.g. "bc-foippa-overview". */
  id: string;
  title: string;
  content: string;
}

/**
 * A provider record kept in both forms: the rendered prose a reader sees, and
 * the validated entry it was rendered from. The assessment pipeline reads
 * residency off `entry` rather than parsing it back out of `content` — the
 * prose is for people, the entry is for code.
 */
export interface ProviderDoc extends KnowledgeDoc {
  entry: ProviderEntry;
}

/** A policy record kept in both forms, for the same reason as {@link ProviderDoc}. */
export interface PolicyDoc extends KnowledgeDoc {
  document: PolicyDocument;
}

export async function loadKnowledgeDir(dirName: string): Promise<KnowledgeDoc[]> {
  const dirPath = join(packageRoot, dirName);
  let entries;
  try {
    entries = await readdir(dirPath, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }

  const docs: KnowledgeDoc[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".md") || entry.name === "README.md") continue;
    const content = await readFile(join(dirPath, entry.name), "utf8");
    const id = entry.name.replace(/\.md$/, "");
    const title = content.match(/^#\s+(.+)$/m)?.[1] ?? id;
    docs.push({ id, title, content });
  }

  docs.sort((a, b) => a.id.localeCompare(b.id));
  return docs;
}

/**
 * Loads the structured provider entries (providers/*.yaml), validates each
 * against {@link providerEntrySchema}, and keeps both the validated entry and
 * its rendered prose (see ./provider-render.ts). `schema.yaml` documents the
 * format and is not itself a provider entry, same treatment as README.md in
 * loadKnowledgeDir.
 *
 * A file's `id` field, not its filename, is the record id — but the two are
 * required to match so a copy-paste or rename mistake fails loudly instead
 * of shipping a provider record under the wrong id.
 *
 * Recurses into subdirectories (e.g. providers/bcgov/) so services specific
 * to one organization can be grouped separately from the general registry
 * while still loading as ordinary provider records.
 */
export async function loadProviderRecords(dirName: string): Promise<ProviderDoc[]> {
  const dirPath = join(packageRoot, dirName);
  const relativePaths = await listYamlFilesRecursive(dirPath);

  const docs: ProviderDoc[] = [];
  for (const relativePath of relativePaths) {
    const raw = await readFile(join(dirPath, relativePath), "utf8");
    const parsed = providerEntrySchema.safeParse(parseYaml(raw));
    if (!parsed.success) {
      throw new Error(`Invalid provider entry in ${dirName}/${relativePath}: ${parsed.error.message}`);
    }

    const filenameId = relativePath.split("/").pop()!.replace(/\.ya?ml$/, "");
    if (parsed.data.id !== filenameId) {
      throw new Error(
        `Provider entry ${dirName}/${relativePath} has id "${parsed.data.id}", which doesn't match its filename. Rename the file or fix the id field.`,
      );
    }

    docs.push({
      id: parsed.data.id,
      title: parsed.data.name,
      content: renderProvider(parsed.data),
      entry: parsed.data,
    });
  }

  docs.sort((a, b) => a.id.localeCompare(b.id));
  return docs;
}

/**
 * Loads the structured policy documents (policies/*.yaml), validates each
 * against {@link policyDocumentSchema}, and keeps both the validated document
 * and its rendered prose (see ./policy-render.ts). Mirrors
 * {@link loadProviderRecords} exactly, including
 * the id-matches-filename requirement and the `schema.yaml` /
 * subdirectory-recursion behavior of {@link listYamlFilesRecursive}.
 */
export async function loadPolicyRecords(dirName: string): Promise<PolicyDoc[]> {
  const dirPath = join(packageRoot, dirName);
  const relativePaths = await listYamlFilesRecursive(dirPath);

  const docs: PolicyDoc[] = [];
  for (const relativePath of relativePaths) {
    const raw = await readFile(join(dirPath, relativePath), "utf8");
    const parsed = policyDocumentSchema.safeParse(parseYaml(raw));
    if (!parsed.success) {
      throw new Error(`Invalid policy document in ${dirName}/${relativePath}: ${parsed.error.message}`);
    }

    const filenameId = relativePath.split("/").pop()!.replace(/\.ya?ml$/, "");
    if (parsed.data.id !== filenameId) {
      throw new Error(
        `Policy document ${dirName}/${relativePath} has id "${parsed.data.id}", which doesn't match its filename. Rename the file or fix the id field.`,
      );
    }

    docs.push({
      id: parsed.data.id,
      title: parsed.data.title,
      content: renderPolicy(parsed.data),
      document: parsed.data,
    });
  }

  docs.sort((a, b) => a.id.localeCompare(b.id));
  return docs;
}

async function listYamlFilesRecursive(dirPath: string, prefix = ""): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(dirPath, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }

  const results: string[] = [];
  for (const entry of entries) {
    if (entry.isDirectory()) {
      results.push(...(await listYamlFilesRecursive(join(dirPath, entry.name), `${prefix}${entry.name}/`)));
      continue;
    }
    if (!entry.isFile() || !/\.ya?ml$/.test(entry.name) || entry.name === "schema.yaml") continue;
    results.push(`${prefix}${entry.name}`);
  }
  return results;
}
