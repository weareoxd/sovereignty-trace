import { createHash } from "node:crypto";

/** Largest line range `sg_cite_evidence` will return in one call. */
export const MAX_EVIDENCE_LINES = 40;

export interface EvidenceSlice {
  /** 1-based, inclusive, already clamped to the file. */
  startLine: number;
  endLine: number;
  text: string;
}

/**
 * Extracts an inclusive, 1-based line range, clamped to the file and capped
 * at {@link MAX_EVIDENCE_LINES}. Returns undefined when the range starts past
 * the end of the file, which is the case a citation cannot be repaired from.
 */
export function sliceLines(contents: string, start: number, end: number): EvidenceSlice | undefined {
  const lines = contents.split("\n");
  const startLine = Math.max(1, Math.min(start, end));
  if (startLine > lines.length) return undefined;

  const requestedEnd = Math.max(start, end);
  const endLine = Math.min(lines.length, requestedEnd, startLine + MAX_EVIDENCE_LINES - 1);

  return {
    startLine,
    endLine,
    text: lines.slice(startLine - 1, endLine).join("\n"),
  };
}

/**
 * Mints the handle `sg_cite_evidence` returns and validation later re-derives.
 *
 * It is a hash of the file path, the line range, and the exact text at that
 * range, so it can only be produced by something that has actually read those
 * lines. That is the whole point: a citation carrying a handle that re-derives
 * is proof the agent read the file, rather than a path it typed from memory.
 * No secret is involved, and none is needed, since reproducing a handle
 * requires the file content it commits to.
 */
export function mintEvidenceHandle(file: string, slice: EvidenceSlice): string {
  const digest = createHash("sha256")
    .update(`${normalizeFile(file)}\n${slice.startLine}-${slice.endLine}\n${slice.text}`)
    .digest("hex");
  return `ev_${digest.slice(0, 16)}`;
}

/** Formats a slice's range the way the schema's `lines` field expects. */
export function formatLineRange(slice: EvidenceSlice): string {
  return slice.startLine === slice.endLine ? `${slice.startLine}` : `${slice.startLine}-${slice.endLine}`;
}

function normalizeFile(file: string): string {
  return file.replace(/\\/g, "/").replace(/^\.\//, "");
}
