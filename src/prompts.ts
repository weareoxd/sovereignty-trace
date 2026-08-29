import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { packageRoot } from "./paths.js";

/** Loads a prompt file from `prompts/` (the assessment methodology, agent role, ...). */
export async function loadPromptFile(name: string): Promise<string> {
  return readFile(join(packageRoot, "prompts", name), "utf8");
}
