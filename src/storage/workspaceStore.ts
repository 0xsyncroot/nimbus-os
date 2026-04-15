// workspaceStore.ts — SPEC-101: filesystem CRUD for workspaces under workspacesDir().
// Atomic create via tmp+rename, symlink-safe load, list sorted by lastUsed.

import { chmod, lstat, mkdir, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ErrorCode, NimbusError } from '../observability/errors.ts';
import { workspacesDir } from '../platform/paths.ts';
import { detect } from '../platform/detect.ts';
import { newToolUseId } from '../ir/helpers.ts';
import {
  WORKSPACE_JSON_MAX_BYTES,
  WorkspaceSchema,
  type Workspace,
  type WorkspacePaths,
} from '../core/workspaceTypes.ts';

const SOUL_TEMPLATE = (name: string, dateIso: string) => `---
schemaVersion: 1
name: ${name}
created: ${dateIso}
---

# SOUL — ${name}

Your agent's persona. Edit to define tone, values, and preferred style.
`;

const IDENTITY_TEMPLATE = `---
schemaVersion: 1
---

# IDENTITY

Role / background / context. Optional.
`;

const MEMORY_TEMPLATE = (dateIso: string) => `---
schemaVersion: 1
updated: ${dateIso}
---

# MEMORY

Persistent notes across sessions.
`;

const TOOLS_TEMPLATE = `---
schemaVersion: 1
---

# TOOLS

Runtime tool manifest.
`;

function wsPaths(wsId: string, root?: string): WorkspacePaths {
  const base = root ?? join(workspacesDir(), wsId);
  return {
    root: base,
    soulMd: join(base, 'SOUL.md'),
    identityMd: join(base, 'IDENTITY.md'),
    memoryMd: join(base, 'MEMORY.md'),
    toolsMd: join(base, 'TOOLS.md'),
    sessionsDir: join(base, 'sessions'),
    costsDir: join(base, 'costs'),
  };
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await lstat(p);
    return true;
  } catch {
    return false;
  }
}

async function nameExists(name: string): Promise<boolean> {
  const list = await listWorkspaces().catch(() => [] as Workspace[]);
  return list.some((w) => w.name === name);
}

export interface CreateInput {
  name: string;
  defaultProvider?: string;
  defaultModel?: string;
  defaultEndpoint?: 'openai' | 'groq' | 'deepseek' | 'ollama' | 'custom';
  defaultBaseUrl?: string;
  injectFailAfterDir?: () => Promise<void>;
}

export async function createWorkspaceDir(input: CreateInput): Promise<{ meta: Workspace; paths: WorkspacePaths }> {
  if (!/^[a-z0-9-]{1,64}$/.test(input.name)) {
    throw new NimbusError(ErrorCode.U_BAD_COMMAND, { reason: 'invalid_name', name: input.name });
  }
  if (await nameExists(input.name)) {
    throw new NimbusError(ErrorCode.U_BAD_COMMAND, { reason: 'duplicate_name', name: input.name });
  }
  const id = newToolUseId();
  const now = Date.now();
  const meta: Workspace = WorkspaceSchema.parse({
    schemaVersion: 1,
    id,
    name: input.name,
    createdAt: now,
    lastUsed: now,
    defaultProvider: input.defaultProvider ?? 'anthropic',
    defaultModel: input.defaultModel ?? 'claude-sonnet-4-6',
    ...(input.defaultEndpoint !== undefined ? { defaultEndpoint: input.defaultEndpoint } : {}),
    ...(input.defaultBaseUrl !== undefined ? { defaultBaseUrl: input.defaultBaseUrl } : {}),
  });
  const paths = wsPaths(id);
  await mkdir(workspacesDir(), { recursive: true });
  await mkdir(paths.root, { recursive: false });
  try {
    if (input.injectFailAfterDir) await input.injectFailAfterDir();
    await mkdir(paths.sessionsDir, { recursive: true });
    await mkdir(paths.costsDir, { recursive: true });
    // Write workspace.json via tmp + rename
    const tmp = join(paths.root, 'workspace.json.tmp');
    const payload = JSON.stringify(meta, null, 2);
    if (Buffer.byteLength(payload, 'utf8') > WORKSPACE_JSON_MAX_BYTES) {
      throw new NimbusError(ErrorCode.S_CONFIG_INVALID, { reason: 'workspace_json_too_large' });
    }
    await writeFile(tmp, payload, { encoding: 'utf8' });
    await rename(tmp, join(paths.root, 'workspace.json'));
    const dateIso = new Date(now).toISOString().slice(0, 10);
    await writeFile(paths.soulMd, SOUL_TEMPLATE(input.name, dateIso), { encoding: 'utf8' });
    await writeFile(paths.identityMd, IDENTITY_TEMPLATE, { encoding: 'utf8' });
    await writeFile(paths.memoryMd, MEMORY_TEMPLATE(dateIso), { encoding: 'utf8' });
    await writeFile(paths.toolsMd, TOOLS_TEMPLATE, { encoding: 'utf8' });
    if (detect().os !== 'win32') {
      await chmod(join(paths.root, 'workspace.json'), 0o600).catch(() => undefined);
    }
  } catch (err) {
    // rollback
    await rm(paths.root, { recursive: true, force: true }).catch(() => undefined);
    if (err instanceof NimbusError) throw err;
    throw new NimbusError(ErrorCode.S_STORAGE_CORRUPT, { reason: 'create_failed', err: (err as Error).message });
  }
  return { meta, paths };
}

export async function loadWorkspace(wsId: string): Promise<{ meta: Workspace; paths: WorkspacePaths }> {
  const paths = wsPaths(wsId);
  const metaPath = join(paths.root, 'workspace.json');
  let st;
  try {
    st = await lstat(metaPath);
  } catch {
    throw new NimbusError(ErrorCode.T_NOT_FOUND, { reason: 'workspace_missing', wsId });
  }
  if (st.isSymbolicLink()) {
    throw new NimbusError(ErrorCode.X_PATH_BLOCKED, { reason: 'symlink', path: metaPath });
  }
  if (st.size > WORKSPACE_JSON_MAX_BYTES) {
    throw new NimbusError(ErrorCode.S_CONFIG_INVALID, { reason: 'workspace_json_too_large', size: st.size });
  }
  const raw = await Bun.file(metaPath).text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new NimbusError(ErrorCode.S_CONFIG_INVALID, { reason: 'invalid_json', path: metaPath });
  }
  if (parsed && typeof parsed === 'object' && 'schemaVersion' in parsed) {
    const ver = (parsed as { schemaVersion: unknown }).schemaVersion;
    if (typeof ver === 'number' && ver !== 1) {
      throw new NimbusError(ErrorCode.S_SCHEMA_MISMATCH, { schemaVersion: ver });
    }
  }
  const res = WorkspaceSchema.safeParse(parsed);
  if (!res.success) {
    throw new NimbusError(ErrorCode.S_CONFIG_INVALID, {
      reason: 'invalid_workspace_meta',
      issues: res.error.issues.map((i) => i.message),
    });
  }
  return { meta: res.data, paths };
}

export async function listWorkspaces(): Promise<Workspace[]> {
  const root = workspacesDir();
  let entries: string[] = [];
  try {
    entries = await readdir(root);
  } catch {
    return [];
  }
  const results: Workspace[] = [];
  await Promise.all(
    entries.map(async (entry) => {
      try {
        const { meta } = await loadWorkspace(entry);
        results.push(meta);
      } catch {
        // ignore non-conforming
      }
    }),
  );
  results.sort((a, b) => b.lastUsed - a.lastUsed);
  return results;
}

export async function updateWorkspace(wsId: string, patch: Partial<Workspace>): Promise<Workspace> {
  const { meta, paths } = await loadWorkspace(wsId);
  const next = WorkspaceSchema.parse({ ...meta, ...patch, id: meta.id, schemaVersion: 1 });
  const metaPath = join(paths.root, 'workspace.json');
  const tmp = `${metaPath}.tmp`;
  await writeFile(tmp, JSON.stringify(next, null, 2), { encoding: 'utf8' });
  await rename(tmp, metaPath);
  return next;
}

export async function workspacePathsFor(wsId: string): Promise<WorkspacePaths> {
  return wsPaths(wsId);
}

export { fileExists };
