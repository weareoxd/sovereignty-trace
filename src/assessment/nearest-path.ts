import { basename, extname } from "node:path";

/**
 * Finds the repository file a bad evidence citation most likely meant.
 *
 * The failure this exists for is an agent that read the right file but wrote
 * the wrong path for it when serializing its answer — typically the correct
 * filename under a directory borrowed from some other file it also read
 * (`backend/src/common/guards/auth.jwt-strategy.ts` for what is really
 * `backend/src/auth/auth.jwt-strategy.ts`). The filename therefore carries
 * far more signal than the directory, so an exact basename match is tried
 * first and only then a whole-path similarity search.
 *
 * Returns undefined rather than a poor guess: a wrong suggestion in a
 * compliance report is worse than none.
 */
export function suggestNearestPath(citedPath: string, files: string[]): string | undefined {
  if (files.length === 0) return undefined;

  const cited = normalize(citedPath);
  if (cited.length === 0) return undefined;

  const citedBase = basename(cited);

  const sameBasename = files.filter((file) => basename(file) === citedBase);
  if (sameBasename.length > 0) return closestByPath(cited, sameBasename);

  // Same filename, different extension (`.ts` cited for a `.js` file, and
  // similar near-misses).
  const citedStem = stem(citedBase);
  if (citedStem.length > 0) {
    const sameStem = files.filter((file) => stem(basename(file)) === citedStem);
    if (sameStem.length > 0) return closestByPath(cited, sameStem);
  }

  return closestOverall(cited, files);
}

function normalize(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/+/, "").trim();
}

function stem(name: string): string {
  const ext = extname(name);
  return ext.length > 0 ? name.slice(0, -ext.length) : name;
}

/** Picks the candidate whose full path is closest to the cited one. */
function closestByPath(cited: string, candidates: string[]): string {
  let best = candidates[0]!;
  let bestDistance = editDistance(cited, best);
  for (const candidate of candidates.slice(1)) {
    const distance = editDistance(cited, candidate);
    if (distance < bestDistance) {
      best = candidate;
      bestDistance = distance;
    }
  }
  return best;
}

/**
 * How far a filename may drift and still count as the same file misspelled.
 * Scaled to length, so `auth.jwt-strategies.ts` can reach
 * `auth.jwt-strategy.ts` while `nope.ts` cannot reach `index.ts`, and capped
 * so a long name can't drift into an unrelated one.
 */
function basenameDrift(name: string): number {
  return Math.min(3, Math.max(1, Math.floor(name.length / 4)));
}

/**
 * Similarity search over candidates whose *filename* is a near miss, used
 * only when no filename matched exactly. Deliberately strict: at this point
 * the agent got the filename itself wrong, so confidence is already low, and
 * offering an unrelated file that happens to sit a few edits away is worse
 * than offering nothing.
 */
function closestOverall(cited: string, files: string[]): string | undefined {
  const citedExt = extname(cited);
  const citedBase = basename(cited);
  const drift = basenameDrift(citedBase);

  const nearMisses = files.filter((file) => {
    if (citedExt.length > 0 && extname(file) !== citedExt) return false;
    return editDistance(citedBase, basename(file), drift) <= drift;
  });

  return nearMisses.length > 0 ? closestByPath(cited, nearMisses) : undefined;
}

/**
 * Levenshtein distance over two rolling rows. `limit`, when given, abandons
 * the comparison as soon as every cell in a row exceeds it, so scanning a
 * large repository stays cheap.
 */
function editDistance(a: string, b: string, limit = Number.POSITIVE_INFINITY): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  let current = new Array<number>(b.length + 1);

  for (let i = 1; i <= a.length; i++) {
    current[0] = i;
    let rowMinimum = current[0]!;

    for (let j = 1; j <= b.length; j++) {
      const substitution = previous[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1);
      const deletion = previous[j]! + 1;
      const insertion = current[j - 1]! + 1;
      current[j] = Math.min(substitution, deletion, insertion);
      if (current[j]! < rowMinimum) rowMinimum = current[j]!;
    }

    if (rowMinimum > limit) return rowMinimum;

    const swap = previous;
    previous = current;
    current = swap;
  }

  return previous[b.length]!;
}
