import { createHash } from "node:crypto";

/** Largest line range a single citation will quote. */
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
 * A stable key for one exact file, line range, and the text at it.
 *
 * Two citations of the same lines produce the same key, and any edit to those
 * lines produces a different one, which is what makes it useful for spotting
 * duplicate citations and for telling whether a report still matches the
 * revision it was written against.
 *
 * It no longer verifies anything. It used to: the agent wrote the snippet from
 * memory and a matching handle was the evidence it had really read the file.
 * ./hydrate-evidence.ts reads the text out of the repository directly now, so
 * there is no agent-written snippet left to check.
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
