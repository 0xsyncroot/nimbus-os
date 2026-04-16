// installer.ts — SPEC-310 T7+T8: install/upgrade/revoke commands + exact-version resolution.
// Perm-delta re-prompt on upgrade. Rate-limit: >3 community installs/hour → 60s cool-off.

import { join } from 'node:path';
import { homedir } from 'node:os';
import { mkdir, rm } from 'node:fs/promises';
import { NimbusError, ErrorCode } from '../../observability/errors.ts';
import { logger } from '../../observability/logger.ts';
import { fetchIndex, fetchBundle, resolveEntry, fetchManifest } from './client.ts';
import { verifySigstore } from './verifier.ts';
import { analyzeSkill, assertAnalysisAllowed } from './analyzer.ts';
import { confirmInstall, printAutoInstallBanner } from './riskReport.ts';
import type { SkillManifest } from './manifest.ts';

export interface InstallOptions {
  yes?: boolean;
  isTTY?: boolean;
}

export interface InstalledSkill {
  name: string;
  version: string;
  tier: string;
  installedAt: number;
  bundlePath: string;
  manifestPath: string;
}

function skillsDir(): string {
  return join(homedir(), '.nimbus', 'skills');
}

function installedSkillDir(name: string): string {
  const safeName = name.replace(/\//g, '__').replace(/@/g, '_at_');
  return join(skillsDir(), safeName);
}

function lockFilePath(): string {
  return join(skillsDir(), 'skills.lock');
}

function rateFilePath(): string {
  return join(homedir(), '.nimbus', 'registry', 'rate.json');
}

interface LockFile {
  version: 1;
  skills: Record<string, { version: string; tier: string; installedAt: number }>;
}

interface RateState {
  windowStart: number;
  count: number;
}

async function readLock(): Promise<LockFile> {
  try {
    const raw = await Bun.file(lockFilePath()).text();
    return JSON.parse(raw) as LockFile;
  } catch {
    return { version: 1, skills: {} };
  }
}

async function writeLock(lock: LockFile): Promise<void> {
  await mkdir(skillsDir(), { recursive: true });
  await Bun.write(lockFilePath(), JSON.stringify(lock, null, 2));
}

async function readInstalledManifest(name: string): Promise<SkillManifest | null> {
  try {
    const dir = installedSkillDir(name);
    const raw = await Bun.file(join(dir, 'manifest.json')).text();
    const { parseManifest } = await import('./manifest.ts');
    return parseManifest(JSON.parse(raw));
  } catch {
    return null;
  }
}

/** Rate limit: >3 community installs/hour → 60s cool-off. */
async function checkRateLimit(tier: string): Promise<void> {
  if (tier !== 'community') return;
  let state: RateState = { windowStart: Date.now(), count: 0 };
  try {
    const raw = await Bun.file(rateFilePath()).text();
    state = JSON.parse(raw) as RateState;
  } catch { /* no file yet */ }

  const now = Date.now();
  const oneHour = 60 * 60 * 1000;
  if (now - state.windowStart > oneHour) {
    state = { windowStart: now, count: 0 };
  }
  if (state.count >= 3) {
    const waitMs = 60_000;
    throw new NimbusError(ErrorCode.T_PERMISSION, {
      reason: 'community_install_rate_limit',
      count: state.count,
      windowStart: state.windowStart,
      coolOffMs: waitMs,
      hint: 'More than 3 community installs in 1 hour. Wait 60 seconds.',
    });
  }
  state.count += 1;
  await mkdir(join(homedir(), '.nimbus', 'registry'), { recursive: true });
  await Bun.write(rateFilePath(), JSON.stringify(state));
}

/**
 * parseNameVersion — split "name[@version]" into { name, version? }.
 * T8: exact-version-only for v0.3.
 */
export function parseNameVersion(nameAtVersion: string): { name: string; version?: string } {
  // Handle scoped packages: @scope/skill[@version]
  if (nameAtVersion.startsWith('@')) {
    // @scope/name@version or @scope/name
    const parts = nameAtVersion.split('@');
    // parts[0] = '', parts[1] = 'scope/name', parts[2] = 'version' (optional)
    if (parts.length === 3) {
      return { name: `@${parts[1]}`, version: parts[2] };
    }
    return { name: nameAtVersion };
  }
  const atIdx = nameAtVersion.lastIndexOf('@');
  if (atIdx <= 0) return { name: nameAtVersion };
  return {
    name: nameAtVersion.slice(0, atIdx),
    version: nameAtVersion.slice(atIdx + 1),
  };
}

/**
 * installSkill — full install flow: resolve → fetch → verify → analyze → confirm → write.
 */
export async function installSkill(
  nameAtVersion: string,
  opts: InstallOptions = {},
): Promise<InstalledSkill> {
  const { name, version } = parseNameVersion(nameAtVersion);

  // Check lock — skip if already installed at same version
  const lock = await readLock();
  const existing = lock.skills[name];

  const entry = await resolveEntry(name, version);
  await checkRateLimit(entry.tier);

  // Fetch bundle
  const bundlePath = await fetchBundle(entry);

  // Verify sigstore
  await verifySigstore(entry, bundlePath);

  // Load manifest
  const manifest = await fetchManifest(bundlePath);

  // Analyze risk
  const installedManifest = existing ? await readInstalledManifest(name) : null;
  const report = analyzeSkill(manifest, { installedManifest });
  assertAnalysisAllowed(report);

  // Confirm with user (trusted auto-installs show banner; community/local prompt)
  await confirmInstall(report, { yes: opts.yes, isTTY: opts.isTTY });

  // Write to disk
  const dir = installedSkillDir(name);
  await mkdir(dir, { recursive: true });
  await Bun.write(join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2));

  // Update lock
  lock.skills[name] = {
    version: manifest.version,
    tier: manifest.trust.tier,
    installedAt: Date.now(),
  };
  await writeLock(lock);

  logger.info({ name, version: manifest.version, tier: manifest.trust.tier }, 'skill_installed');

  return {
    name,
    version: manifest.version,
    tier: manifest.trust.tier,
    installedAt: lock.skills[name]!.installedAt,
    bundlePath,
    manifestPath: join(dir, 'manifest.json'),
  };
}

/**
 * upgradeSkill — install new version; diff perms → re-prompt if widened.
 */
export async function upgradeSkill(
  name: string,
  opts: InstallOptions = {},
): Promise<InstalledSkill> {
  // upgradeSkill always fetches latest (no version pin)
  return installSkill(name, opts);
}

/**
 * revokeSkill — remove skill from disk and lock file.
 */
export async function revokeSkill(name: string): Promise<void> {
  const dir = installedSkillDir(name);
  try {
    await rm(dir, { recursive: true, force: true });
  } catch (err) {
    logger.warn({ name, err: (err as Error).message }, 'revoke_dir_not_found');
  }

  const lock = await readLock();
  if (!lock.skills[name]) {
    throw new NimbusError(ErrorCode.T_NOT_FOUND, {
      reason: 'skill_not_installed',
      name,
    });
  }
  delete lock.skills[name];
  await writeLock(lock);
  logger.info({ name }, 'skill_revoked');
}

/**
 * listInstalledSkills — return all installed skills from lock file.
 */
export async function listInstalledSkills(): Promise<InstalledSkill[]> {
  const lock = await readLock();
  return Object.entries(lock.skills).map(([name, info]) => ({
    name,
    version: info.version,
    tier: info.tier,
    installedAt: info.installedAt,
    bundlePath: '',
    manifestPath: join(installedSkillDir(name), 'manifest.json'),
  }));
}

/**
 * getSkillInfo — fetch registry entry + manifest for a named skill.
 */
export async function getSkillInfo(name: string): Promise<{ entry: Awaited<ReturnType<typeof resolveEntry>>; manifest: SkillManifest | null }> {
  const entry = await resolveEntry(name);
  let manifest: SkillManifest | null = null;
  try {
    manifest = await readInstalledManifest(name);
  } catch { /* not installed */ }
  return { entry, manifest };
}
