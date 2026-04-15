// workspace.ts — SPEC-101 lifecycle wrapper: create/switch/getActive on top of workspaceStore.

import { join } from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { ErrorCode, NimbusError } from '../observability/errors.ts';
import { configDir } from '../platform/paths.ts';
import {
  createWorkspaceDir,
  listWorkspaces,
  loadWorkspace,
} from '../storage/workspaceStore.ts';
import type { Workspace } from './workspaceTypes.ts';

const CONFIG_FILE = 'config.json';

interface UserConfig {
  activeWorkspace?: string;
  [k: string]: unknown;
}

async function readUserConfig(): Promise<UserConfig> {
  const path = join(configDir(), CONFIG_FILE);
  const f = Bun.file(path);
  if (!(await f.exists())) return {};
  try {
    const raw = await f.text();
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') return parsed as UserConfig;
    return {};
  } catch {
    return {};
  }
}

async function writeUserConfig(cfg: UserConfig): Promise<void> {
  await mkdir(configDir(), { recursive: true });
  const path = join(configDir(), CONFIG_FILE);
  await writeFile(path, JSON.stringify(cfg, null, 2), { encoding: 'utf8' });
}

export async function createWorkspace(name: string): Promise<Workspace> {
  const { meta } = await createWorkspaceDir({ name });
  return meta;
}

export async function switchWorkspace(wsId: string): Promise<void> {
  const { meta } = await loadWorkspace(wsId);
  const cfg = await readUserConfig();
  cfg['activeWorkspace'] = meta.id;
  await writeUserConfig(cfg);
}

export async function getActiveWorkspace(): Promise<Workspace | null> {
  const cfg = await readUserConfig();
  const id = cfg['activeWorkspace'];
  if (typeof id !== 'string' || id.length === 0) return null;
  try {
    const { meta } = await loadWorkspace(id);
    return meta;
  } catch (err) {
    if (err instanceof NimbusError && err.code === ErrorCode.T_NOT_FOUND) return null;
    throw err;
  }
}

export async function listAllWorkspaces(): Promise<Workspace[]> {
  return listWorkspaces();
}
