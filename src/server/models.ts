import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { AdapterModel } from "@paperclipai/adapter-utils";
import { models as fallbackModels } from "../index.js";

const execFileAsync = promisify(execFile);

/**
 * Parse `devin models list` output. Model lines are indented two spaces and
 * look like:
 *
 *   SWE-2 (swe-2)
 *     aliases: swe
 *     swe-2-high                    SWE-2 High  [262K context, Free]
 */
export function parseDevinModelsList(output: string): AdapterModel[] {
  const models: AdapterModel[] = [];
  const seen = new Set<string>();
  for (const rawLine of output.split(/\r?\n/)) {
    const match = /^ {2}([a-zA-Z0-9][\w.-]*)\s{2,}(.+?)(?:\s*\[.*\])?\s*$/.exec(rawLine);
    if (!match) continue;
    const id = match[1];
    if (id === "aliases:") continue;
    if (seen.has(id)) continue;
    seen.add(id);
    models.push({ id, label: match[2].trim() || id });
  }
  return models;
}

/**
 * Discover the models available to the operator's Devin account. Falls back to
 * the static list when the CLI cannot answer (logged out, offline, old CLI).
 */
export async function listDevinModels(): Promise<AdapterModel[]> {
  try {
    const { stdout } = await execFileAsync("devin", ["models", "list"], {
      timeout: 20_000,
      maxBuffer: 4 * 1024 * 1024,
      windowsHide: true,
    });
    const parsed = parseDevinModelsList(stdout);
    return parsed.length > 0 ? parsed : fallbackModels;
  } catch {
    return fallbackModels;
  }
}
