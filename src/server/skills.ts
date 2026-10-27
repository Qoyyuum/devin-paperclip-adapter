import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type {
  AdapterSkillContext,
  AdapterSkillSnapshot,
} from "@paperclipai/adapter-utils";
import {
  buildPersistentSkillSnapshot,
  ensurePaperclipSkillSymlink,
  isPaperclipSkillSourceMissing,
  parseObject,
  readInstalledSkillTargets,
  readPaperclipRuntimeSkillEntries,
  removeMaintainerOnlySkillSymlinks,
  resolveLegacyPaperclipDesiredSkillNames,
  asString,
} from "@paperclipai/adapter-utils/server-utils";

const __moduleDir = path.dirname(fileURLToPath(import.meta.url));

export const DEVIN_SKILLS_HOME_LABEL = "~/.agents/skills";

/**
 * Devin discovers user-level skills from ~/.agents/skills (alongside
 * ~/.config/devin/skills and ~/.config/cognition/skills). The .agents dir is
 * the cross-harness convention location and resolves the same way on every
 * platform devin runs on. An explicit HOME override in the adapter config env
 * is honored so managed sandbox homes work.
 */
export function resolveDevinSkillsHome(config: Record<string, unknown>): string {
  const env = parseObject(config.env);
  const configuredHome = asString(env.HOME, "").trim();
  const home = configuredHome ? path.resolve(configuredHome) : os.homedir();
  return path.join(home, ".agents", "skills");
}

async function buildDevinSkillSnapshot(
  config: Record<string, unknown>,
): Promise<AdapterSkillSnapshot> {
  const availableEntries = await readPaperclipRuntimeSkillEntries(config, __moduleDir);
  const desiredSkills = resolveLegacyPaperclipDesiredSkillNames(config, availableEntries);
  const skillsHome = resolveDevinSkillsHome(config);
  const installed = await readInstalledSkillTargets(skillsHome);
  return buildPersistentSkillSnapshot({
    adapterType: "devin_local",
    availableEntries,
    desiredSkills,
    installed,
    skillsHome,
    locationLabel: DEVIN_SKILLS_HOME_LABEL,
    installedDetail: "Linked into the Devin global skills directory.",
    missingDetail: "Will be linked into the Devin global skills directory on the next run.",
    externalConflictDetail:
      "A user-installed skill with this name exists in the Devin global skills directory; Paperclip does not overwrite it.",
    externalDetail: "Installed outside Paperclip management in the Devin skills home.",
  });
}

export async function listDevinSkills(ctx: AdapterSkillContext): Promise<AdapterSkillSnapshot> {
  return buildDevinSkillSnapshot(ctx.config);
}

export async function syncDevinSkillsSnapshot(
  ctx: AdapterSkillContext,
  _desiredSkills: string[],
): Promise<AdapterSkillSnapshot> {
  await syncDevinSkills(ctx.config);
  return buildDevinSkillSnapshot(ctx.config);
}

/**
 * Link desired Paperclip skills into the Devin global skills directory and
 * remove stale Paperclip-managed links. Existing non-symlink entries and
 * links not owned by Paperclip are left alone.
 */
export async function syncDevinSkills(
  config: Record<string, unknown>,
  onLog?: (stream: "stdout" | "stderr", chunk: string) => Promise<void>,
): Promise<void> {
  const availableEntries = await readPaperclipRuntimeSkillEntries(config, __moduleDir);
  const desiredNames = new Set(
    resolveLegacyPaperclipDesiredSkillNames(config, availableEntries),
  );
  if (desiredNames.size === 0) return;

  const skillsHome = resolveDevinSkillsHome(config);
  await fs.mkdir(skillsHome, { recursive: true });

  const desiredRuntimeNames = new Set<string>();
  let linked = 0;
  for (const entry of availableEntries) {
    if (!desiredNames.has(entry.key)) continue;
    if (isPaperclipSkillSourceMissing(entry)) continue;
    desiredRuntimeNames.add(entry.runtimeName);
    const outcome = await ensurePaperclipSkillSymlink(
      entry.source,
      path.join(skillsHome, entry.runtimeName),
      // Skills are directories; junctions link directories on Windows without
      // requiring elevated privileges (unlike plain directory symlinks).
      (source, target) =>
        fs.symlink(source, target, process.platform === "win32" ? "junction" : undefined),
    );
    if (outcome !== "skipped") linked += 1;
  }

  const removed = await removeMaintainerOnlySkillSymlinks(skillsHome, desiredRuntimeNames);
  if (onLog && (linked > 0 || removed.length > 0)) {
    await onLog(
      "stderr",
      `[paperclip] Synced ${linked} Paperclip skill(s) into ${skillsHome}${removed.length > 0 ? `; removed ${removed.length} stale link(s)` : ""}.\n`,
    );
  }
}
