import { readFile, stat } from "node:fs/promises";
import { isAbsolute, join, normalize, relative, resolve } from "node:path";
import { z } from "zod";
import {
  formatLineRange,
  mintEvidenceHandle,
  sliceLines,
  MAX_EVIDENCE_LINES,
} from "../assessment/evidence-handle.js";
import { suggestNearestPath } from "../assessment/nearest-path.js";
import { listRepositoryFiles } from "../assessment/repository-info.js";
import type { SgToolDef, SgToolResult } from "./sg-tool-defs.js";

/**
 * Repository-scoped SG tools. Unlike the provider/policy tools in
 * ./sg-tool-defs.ts these need to know which repository is being assessed, so
 * they're built per session rather than exported as a fixed list.
 *
 * `sg_cite_evidence` closes the gap that provider and policy knowledge never
 * had: those are retrieved through a tool and validated against a record,
 * while repository evidence was written from memory at the end of a long
 * session and only checked afterwards. Routing citations through a tool that
 * returns the real text means a finding's evidence is something the agent was
 * handed, not something it recalled.
 */
export interface RepositoryToolContext {
  repositoryPath: string;
  /** Repository-relative file listing, used for the nearest-match hint. */
  files?: string[];
}

function jsonResult(value: unknown): SgToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

function errorResult(text: string): SgToolResult {
  return { content: [{ type: "text", text }], isError: true };
}

export function createRepositoryToolDefs(context: RepositoryToolContext): SgToolDef[] {
  const repositoryPath = resolve(context.repositoryPath);
  let fileCache = context.files;

  const repositoryFiles = async (): Promise<string[]> => {
    fileCache ??= await listRepositoryFiles(repositoryPath);
    return fileCache;
  };

  return [
    {
      name: "sg_cite_evidence",
      description:
        "Read an exact line range from the repository under assessment and mint the citation handle for it. Call this for every piece of evidence you intend to cite, and copy the returned `file`, `lines`, `snippet`, and `evidenceId` into that evidence entry verbatim. Do not write an evidence entry from memory: a path or snippet that this tool did not return cannot be verified and will be reported as unverified.",
      inputSchema: {
        file: z
          .string()
          .describe("Repository-relative path to read, e.g. \"backend/src/auth/auth.jwt-strategy.ts\"."),
        lines: z
          .string()
          .describe(
            `Line number or inclusive range to quote, e.g. "42" or "12-18". At most ${MAX_EVIDENCE_LINES} lines are returned.`,
          ),
      },
      handler: async ({ file, lines }: { file: string; lines: string }) => {
        if (isAbsolute(file)) {
          return errorResult(
            `"${file}" is an absolute path. Pass a path relative to the repository root.`,
          );
        }

        const resolved = normalize(join(repositoryPath, file));
        if (relative(repositoryPath, resolved).startsWith("..")) {
          return errorResult(`"${file}" resolves outside the repository under assessment.`);
        }

        const range = parseRange(lines);
        if (!range) {
          return errorResult(`Could not read "${lines}" as a line number or range. Use "42" or "12-18".`);
        }

        let fileStat;
        try {
          fileStat = await stat(resolved);
        } catch {
          const suggestion = suggestNearestPath(file, await repositoryFiles());
          return errorResult(
            `No file "${file}" in the repository under assessment.` +
              (suggestion ? ` Did you mean "${suggestion}"?` : "") +
              " Do not cite this path.",
          );
        }

        if (!fileStat.isFile()) return errorResult(`"${file}" is not a regular file.`);

        const contents = await readFile(resolved, "utf8");
        const slice = sliceLines(contents, range.start, range.end);
        if (!slice) {
          return errorResult(
            `"${file}" has ${contents.split("\n").length} line(s); ${lines} starts past the end of the file.`,
          );
        }

        return jsonResult({
          evidenceId: mintEvidenceHandle(file, slice),
          file,
          lines: formatLineRange(slice),
          snippet: slice.text,
        });
      },
    },
  ];
}

function parseRange(lines: string): { start: number; end: number } | undefined {
  const cleaned = lines.trim().replace(/[–—]/g, "-").replace(/[Ll]/g, "");

  const range = /^(\d+)\s*-\s*(\d+)$/.exec(cleaned);
  if (range) return { start: Number(range[1]), end: Number(range[2]) };

  const single = /^(\d+)$/.exec(cleaned);
  if (single) return { start: Number(single[1]), end: Number(single[1]) };

  return undefined;
}
