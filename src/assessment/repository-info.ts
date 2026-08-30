import { execFile } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { basename, extname, join, relative } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface RepositoryInfo {
  name: string;
  commit?: string;
  primaryLanguages: string[];
  /** Total number of files tracked/found in the repository. */
  fileCount: number;
  /**
   * Repository-relative paths of every file found. Carried on the result so
   * consumers that need the listing (evidence validation's nearest-path
   * suggester, the repository evidence tools) reuse this one `git ls-files`
   * rather than re-shelling it.
   */
  files: string[];
  /** Non-blank, non-comment patterns from the repository root's `.gitignore`, if present. */
  ignoredPatterns: string[];
}

/** Directories skipped when a repository isn't a git checkout (or `git ls-files` fails) and file listing falls back to a directory walk. */
const SKIPPED_DIRECTORIES = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  "out",
  "target",
  "vendor",
  ".venv",
  "venv",
]);

/** Maps file extensions to a language label. Extensions not listed here (config, markup, docs, lockfiles, ...) don't count toward primaryLanguages. */
const EXTENSION_LANGUAGE: Record<string, string> = {
  ts: "TypeScript",
  tsx: "TypeScript",
  js: "JavaScript",
  jsx: "JavaScript",
  mjs: "JavaScript",
  cjs: "JavaScript",
  py: "Python",
  rb: "Ruby",
  go: "Go",
  rs: "Rust",
  java: "Java",
  kt: "Kotlin",
  cs: "C#",
  cpp: "C++",
  cc: "C++",
  c: "C",
  h: "C",
  hpp: "C++",
  php: "PHP",
  swift: "Swift",
  scala: "Scala",
  sql: "SQL",
  sh: "Shell",
  bash: "Shell",
};

/** Gathers repository facts deterministically: no coding agent involved, so results don't vary between runs or runtimes. */
export async function gatherRepositoryInfo(repositoryPath: string): Promise<RepositoryInfo> {
  const [commit, files, ignoredPatterns] = await Promise.all([
    getGitCommit(repositoryPath),
    listRepositoryFiles(repositoryPath),
    readGitignorePatterns(repositoryPath),
  ]);

  return {
    name: basename(repositoryPath),
    commit,
    primaryLanguages: detectPrimaryLanguages(files),
    fileCount: files.length,
    files,
    ignoredPatterns,
  };
}

/**
 * Reads the repository root's `.gitignore`, if present, so agent
 * instructions can point at dependency/build noise the agent might
 * otherwise wander into via `Bash` (which, unlike `Grep`/`Glob`, doesn't
 * respect `.gitignore` on its own). Only the root file is read — nested
 * `.gitignore` files are not merged in.
 */
async function readGitignorePatterns(repositoryPath: string): Promise<string[]> {
  let contents: string;
  try {
    contents = await readFile(join(repositoryPath, ".gitignore"), "utf8");
  } catch {
    return [];
  }

  const patterns = contents
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));

  return [...new Set(patterns)];
}

async function getGitCommit(repositoryPath: string): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: repositoryPath });
    return stdout.trim() || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Lists every file in the repository as a repository-relative path, using
 * `git ls-files` where possible and falling back to a directory walk that
 * skips dependency/build directories.
 */
export async function listRepositoryFiles(repositoryPath: string): Promise<string[]> {
  try {
    const { stdout } = await execFileAsync("git", ["ls-files"], { cwd: repositoryPath, maxBuffer: 1024 * 1024 * 32 });
    const files = stdout.split("\n").filter(Boolean);
    if (files.length > 0) return files;
  } catch {
    // not a git checkout, or git isn't available; fall back to walking the tree
  }
  return walkDirectory(repositoryPath, repositoryPath);
}

async function walkDirectory(root: string, dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  const files: string[] = [];
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (SKIPPED_DIRECTORIES.has(entry.name)) continue;
      files.push(...(await walkDirectory(root, join(dir, entry.name))));
    } else if (entry.isFile()) {
      files.push(relative(root, join(dir, entry.name)));
    }
  }
  return files;
}

/** Ranks languages by share of source files, keeping any language that accounts for at least 5% of counted files (capped at 5 languages). */
function detectPrimaryLanguages(files: string[]): string[] {
  const counts = new Map<string, number>();
  for (const file of files) {
    const ext = extname(file).slice(1).toLowerCase();
    const language = EXTENSION_LANGUAGE[ext];
    if (!language) continue;
    counts.set(language, (counts.get(language) ?? 0) + 1);
  }

  const total = [...counts.values()].reduce((sum, count) => sum + count, 0);
  if (total === 0) return [];

  return [...counts.entries()]
    .filter(([, count]) => count / total >= 0.05)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([language]) => language);
}
