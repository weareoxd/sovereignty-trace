import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// This file lives at src/paths.ts -> dist/paths.js, one level below the
// package root where providers/, policies/, and prompts/ ship (see
// package.json "files").
export const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
