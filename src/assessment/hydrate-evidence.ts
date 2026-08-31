import { readFile, stat } from "node:fs/promises";
import { isAbsolute, join, normalize, relative } from "node:path";
import { formatLineRange, mintEvidenceHandle, sliceLines } from "./evidence-handle.js";
import { suggestNearestPath } from "./nearest-path.js";
import type { DraftEvidence, Evidence } from "./schema.js";

/**
 * Stage 3 of the assessment: turn the locations the agent reported into
 * citations, by reading them out of the repository.
 *
 * The agent used to write the snippet itself, copying it from a tool response
 * at the end of a long session, and four of five runs failed verification
 * because of it. It reports a path and a line range now, and the quoted text
 * comes from the file. A fabricated quote is no longer expressible; a path that
 * does not exist is dropped here rather than sent back for another round.
 */

export type EvidenceDropReason =
  | "absolute_path"
  | "outside_repository"
  | "file_missing"
  | "unreadable"
  | "lines_unparseable"
  | "lines_out_of_range";

export interface DroppedEvidence {
  /** Location within the draft, e.g. `components[5].findings[0].evidence[2]`. */
  path: string;
  file: string;
  lines: string;
  reason: EvidenceDropReason;
  message: string;
  /** Repository file this citation most likely meant, when one was found. */
  suggestion?: string;
}

export interface HydrationResult {
  evidence: Evidence[];
  dropped: DroppedEvidence[];
}

export async function hydrateEvidence(
  items: DraftEvidence[],
  pathPrefix: string,
  repositoryPath: string,
  files: string[],
): Promise<HydrationResult> {
  const evidence: Evidence[] = [];
  const dropped: DroppedEvidence[] = [];

  for (const [index, item] of items.entries()) {
    const result = await hydrateOne(item, `${pathPrefix}.evidence[${index}]`, repositoryPath, files);
    if ("dropped" in result) dropped.push(result.dropped);
    else evidence.push(result.evidence);
  }

  return { evidence, dropped };
}

type OneResult = { evidence: Evidence } | { dropped: DroppedEvidence };

async function hydrateOne(
  item: DraftEvidence,
  path: string,
  repositoryPath: string,
  files: string[],
): Promise<OneResult> {
  const base = { path, file: item.file, lines: item.lines };

  if (isAbsolute(item.file)) {
    const asRelative = relative(repositoryPath, item.file);
    const inRepo = !asRelative.startsWith("..") && files.includes(asRelative);
    return {
      dropped: {
        ...base,
        reason: "absolute_path",
        message: `"${item.file}" is an absolute path; citations are repository-relative.`,
        suggestion: inRepo ? asRelative : undefined,
      },
    };
  }

  const resolved = normalize(join(repositoryPath, item.file));
  if (relative(repositoryPath, resolved).startsWith("..")) {
    return {
      dropped: {
        ...base,
        reason: "outside_repository",
        message: `"${item.file}" resolves outside the repository under assessment.`,
      },
    };
  }

  const range = parseLineRange(item.lines);
  if (!range) {
    return {
      dropped: {
        ...base,
        reason: "lines_unparseable",
        message: `Could not read "${item.lines}" as a line number or range.`,
      },
    };
  }

  let fileStat;
  try {
    fileStat = await stat(resolved);
  } catch {
    return {
      dropped: {
        ...base,
        reason: "file_missing",
        message: `"${item.file}" does not exist in the repository.`,
        suggestion: suggestNearestPath(item.file, files),
      },
    };
  }

  if (!fileStat.isFile()) {
    return {
      dropped: { ...base, reason: "unreadable", message: `"${item.file}" is not a regular file.` },
    };
  }

  let contents: string;
  try {
    contents = await readFile(resolved, "utf8");
  } catch (err) {
    return {
      dropped: {
        ...base,
        reason: "unreadable",
        message: `"${item.file}" could not be read: ${(err as Error).message}`,
      },
    };
  }

  const slice = sliceLines(contents, range.start, range.end);
  if (!slice) {
    return {
      dropped: {
        ...base,
        reason: "lines_out_of_range",
        message: `"${item.file}" has ${contents.split("\n").length} line(s); ${item.lines} starts past the end.`,
      },
    };
  }

  return {
    evidence: {
      file: item.file,
      lines: formatLineRange(slice),
      snippet: slice.text,
      evidenceId: mintEvidenceHandle(item.file, slice),
      note: item.note,
    },
  };
}

/** Parses "12", "12-18", or "L12-L18". Anything else is not a range. */
export function parseLineRange(lines: string): { start: number; end: number } | undefined {
  const cleaned = lines.trim().replace(/[–—]/g, "-").replace(/[Ll]/g, "");

  const range = /^(\d+)\s*-\s*(\d+)$/.exec(cleaned);
  if (range) {
    const start = Number(range[1]);
    const end = Number(range[2]);
    return { start: Math.min(start, end), end: Math.max(start, end) };
  }

  const single = /^(\d+)$/.exec(cleaned);
  if (single) {
    const start = Number(single[1]);
    return { start, end: start };
  }

  return undefined;
}
