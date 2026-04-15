// profiles.ts — SPEC-501 T4: profile manager (list/create/delete/switch).

import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { configDir } from '../../platform/paths.ts';
import { ErrorCode, NimbusError } from '../../observability/errors.ts';
import {
  PartialNimbusConfigSchema,
  type PartialNimbusConfig,
} from './schema.ts';

function profilesRoot(): string {
  return join(configDir(), 'profiles');
}

function profilePath(name: string): string {
  assertName(name);
  return join(profilesRoot(), `${name}.json`);
}

function activePointerPath(): string {
  return join(configDir(), 'active-profile.json');
}

function assertName(name: string): void {
  if (!/^[a-zA-Z0-9_-]{1,32}$/.test(name)) {
    throw new NimbusError(ErrorCode.U_BAD_COMMAND, {
      reason: 'invalid_profile_name',
      name,
    });
  }
}

async function atomicWriteJson(path: string, data: unknown, mode = 0o600): Promise<void> {
  const tmp = `${path}.tmp.${process.pid}.${Date.now()}`;
  await writeFile(tmp, JSON.stringify(data, null, 2), { encoding: 'utf8', mode });
  await rename(tmp, path);
}

export async function listProfiles(): Promise<string[]> {
  const root = profilesRoot();
  let entries: string[] = [];
  try {
    entries = await readdir(root);
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.endsWith('.json'))
    .map((e) => e.slice(0, -'.json'.length))
    .sort();
}

export async function createProfile(
  name: string,
  base: PartialNimbusConfig = {},
): Promise<void> {
  assertName(name);
  const root = profilesRoot();
  await mkdir(root, { recursive: true, mode: 0o700 });
  const path = profilePath(name);
  // Refuse overwrite — caller must delete first.
  try {
    await readFile(path, 'utf8');
    throw new NimbusError(ErrorCode.U_BAD_COMMAND, {
      reason: 'profile_exists',
      name,
    });
  } catch (err) {
    if (err instanceof NimbusError) throw err;
    // ENOENT → good, proceed.
  }
  const parsed = PartialNimbusConfigSchema.parse(base);
  await atomicWriteJson(path, parsed);
}

export async function deleteProfile(name: string): Promise<void> {
  assertName(name);
  await rm(profilePath(name), { force: true });
  // If this was the active profile, clear the pointer.
  const active = await readActiveProfile();
  if (active === name) await writeActiveProfile(null);
}

export async function switchProfile(name: string): Promise<void> {
  assertName(name);
  const exists = await profileExists(name);
  if (!exists) {
    throw new NimbusError(ErrorCode.U_BAD_COMMAND, {
      reason: 'profile_not_found',
      name,
    });
  }
  await writeActiveProfile(name);
}

export async function profileExists(name: string): Promise<boolean> {
  try {
    await readFile(profilePath(name), 'utf8');
    return true;
  } catch {
    return false;
  }
}

export async function readProfile(name: string): Promise<PartialNimbusConfig> {
  assertName(name);
  let raw: string;
  try {
    raw = await readFile(profilePath(name), 'utf8');
  } catch {
    return {};
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    throw new NimbusError(
      ErrorCode.S_CONFIG_INVALID,
      { reason: 'profile_json_parse', name },
      err instanceof Error ? err : undefined,
    );
  }
  const result = PartialNimbusConfigSchema.safeParse(json);
  if (!result.success) {
    throw new NimbusError(ErrorCode.S_CONFIG_INVALID, {
      reason: 'profile_schema_invalid',
      name,
      issues: result.error.issues.map((i) => ({
        pointer: '/' + i.path.map(String).join('/'),
        message: i.message,
      })),
    });
  }
  return result.data;
}

export async function readActiveProfile(): Promise<string | null> {
  try {
    const raw = await readFile(activePointerPath(), 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && typeof parsed.name === 'string') {
      return parsed.name as string;
    }
    return null;
  } catch {
    return null;
  }
}

export async function writeActiveProfile(name: string | null): Promise<void> {
  await mkdir(configDir(), { recursive: true, mode: 0o700 });
  if (name === null) {
    await rm(activePointerPath(), { force: true });
    return;
  }
  assertName(name);
  await atomicWriteJson(activePointerPath(), { name });
}
