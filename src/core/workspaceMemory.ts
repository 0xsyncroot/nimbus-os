// workspaceMemory.ts — SPEC-104: load SOUL/IDENTITY/MEMORY/TOOLS markdown files per workspace.

import { lstat } from 'node:fs/promises';
import { join } from 'node:path';
import matter from 'gray-matter';
import jsYaml from 'js-yaml';
import { ErrorCode, NimbusError } from '../observability/errors.ts';
import { logger } from '../observability/logger.ts';
import { workspacesDir } from '../platform/paths.ts';
import {
  DEFAULT_MEMORY_BODY,
  DEFAULT_SOUL_BODY,
  DEFAULT_TOOLS_BODY,
  MAX_FILE_BYTES,
  MemoryFrontmatterSchema,
  SoulFrontmatterSchema,
  ToolsFrontmatterSchema,
  type MarkdownFile,
  type WorkspaceMemory,
} from './memoryTypes.ts';

const cache = new Map<string, { memory: WorkspaceMemory; mtimes: Record<string, number> }>();

export function workspacePaths(wsId: string): {
  root: string;
  soulMd: string;
  identityMd: string;
  memoryMd: string;
  toolsMd: string;
  sessionsDir: string;
  costsDir: string;
} {
  const root = join(workspacesDir(), wsId);
  return {
    root,
    soulMd: join(root, 'SOUL.md'),
    identityMd: join(root, 'IDENTITY.md'),
    memoryMd: join(root, 'MEMORY.md'),
    toolsMd: join(root, 'TOOLS.md'),
    sessionsDir: join(root, 'sessions'),
    costsDir: join(root, 'costs'),
  };
}

function stripBomAndNormalize(s: string): string {
  let out = s;
  if (out.charCodeAt(0) === 0xfeff) out = out.slice(1);
  return out.replace(/\r\n/g, '\n');
}

async function readRaw(path: string): Promise<{ body: string; mtime: number } | null> {
  let st;
  try {
    st = await lstat(path);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return null;
    throw err;
  }
  if (st.isSymbolicLink()) {
    throw new NimbusError(ErrorCode.X_PATH_BLOCKED, { reason: 'symlink', path });
  }
  if (st.size > MAX_FILE_BYTES) {
    throw new NimbusError(ErrorCode.S_SOUL_PARSE, { reason: 'file_too_large', path, size: st.size });
  }
  const file = Bun.file(path);
  const raw = await file.text();
  return { body: stripBomAndNormalize(raw), mtime: st.mtimeMs };
}

function parseMarkdown(path: string, raw: string): { frontmatter: Record<string, unknown>; body: string } {
  const parsed = matter(raw, {
    engines: {
      yaml: {
        parse: (str: string) =>
          jsYaml.load(str, { schema: jsYaml.CORE_SCHEMA }) as object,
        stringify: (obj: object) => jsYaml.dump(obj, { schema: jsYaml.CORE_SCHEMA }),
      },
    },
  });
  if (typeof parsed.data !== 'object' || parsed.data === null) {
    throw new NimbusError(ErrorCode.S_SOUL_PARSE, { reason: 'invalid_frontmatter', path });
  }
  return { frontmatter: parsed.data as Record<string, unknown>, body: parsed.content };
}

async function loadSoul(path: string): Promise<MarkdownFile> {
  const raw = await readRaw(path);
  if (!raw) throw new NimbusError(ErrorCode.S_SOUL_PARSE, { reason: 'soul_missing', path });
  try {
    const { frontmatter, body } = parseMarkdown(path, raw.body);
    const ver = (frontmatter as { schemaVersion?: unknown }).schemaVersion;
    if (typeof ver === 'number' && ver !== 1) {
      throw new NimbusError(ErrorCode.S_SCHEMA_MISMATCH, { file: 'SOUL.md', schemaVersion: ver });
    }
    const parsed = SoulFrontmatterSchema.safeParse(frontmatter);
    if (!parsed.success) {
      logger.warn({ code: ErrorCode.S_SOUL_PARSE, path, issues: parsed.error.issues.map((i) => i.message) }, 'SOUL.md frontmatter invalid; using default body');
      return { frontmatter: {}, body: DEFAULT_SOUL_BODY, mtime: raw.mtime, fallback: true };
    }
    return { frontmatter, body, mtime: raw.mtime };
  } catch (err) {
    if (err instanceof NimbusError) throw err;
    logger.warn({ code: ErrorCode.S_SOUL_PARSE, path, err: (err as Error).message }, 'SOUL.md parse failure; using default body');
    return { frontmatter: {}, body: DEFAULT_SOUL_BODY, mtime: raw.mtime, fallback: true };
  }
}

async function loadOptional(
  path: string,
  schema: { safeParse: (v: unknown) => { success: boolean } },
  defaultBody: string,
  label: string,
): Promise<MarkdownFile | undefined> {
  const raw = await readRaw(path);
  if (!raw) return undefined;
  try {
    const { frontmatter, body } = parseMarkdown(path, raw.body);
    const ver = (frontmatter as { schemaVersion?: unknown }).schemaVersion;
    if (typeof ver === 'number' && ver !== 1) {
      throw new NimbusError(ErrorCode.S_SCHEMA_MISMATCH, { file: label, schemaVersion: ver });
    }
    const parsed = schema.safeParse(frontmatter);
    if (!parsed.success) {
      logger.warn({ path, label }, 'frontmatter invalid; using default body');
      return { frontmatter: {}, body: defaultBody, mtime: raw.mtime, fallback: true };
    }
    return { frontmatter, body, mtime: raw.mtime };
  } catch (err) {
    if (err instanceof NimbusError) throw err;
    logger.warn({ path, label, err: (err as Error).message }, 'markdown parse failure; using default');
    return { frontmatter: {}, body: defaultBody, mtime: raw.mtime, fallback: true };
  }
}

export async function loadWorkspaceMemory(wsId: string): Promise<WorkspaceMemory> {
  const paths = workspacePaths(wsId);
  const cached = cache.get(wsId);
  if (cached) {
    // verify mtimes match — quick lstat batch
    try {
      const stats = await Promise.all([
        lstat(paths.soulMd).catch(() => null),
        lstat(paths.memoryMd).catch(() => null),
        lstat(paths.toolsMd).catch(() => null),
      ]);
      if (
        stats[0] && stats[0].mtimeMs === cached.mtimes['soul'] &&
        stats[1] && stats[1].mtimeMs === cached.mtimes['memory'] &&
        stats[2] && stats[2].mtimeMs === cached.mtimes['tools']
      ) {
        return cached.memory;
      }
    } catch {
      // fall through to reload
    }
  }
  const [soul, identity, mem, tools] = await Promise.all([
    loadSoul(paths.soulMd),
    loadOptional(paths.identityMd, ToolsFrontmatterSchema, '', 'IDENTITY.md'),
    loadOptional(paths.memoryMd, MemoryFrontmatterSchema, DEFAULT_MEMORY_BODY, 'MEMORY.md'),
    loadOptional(paths.toolsMd, ToolsFrontmatterSchema, DEFAULT_TOOLS_BODY, 'TOOLS.md'),
  ]);
  const memoryFile: MarkdownFile = mem ?? { frontmatter: {}, body: DEFAULT_MEMORY_BODY, mtime: 0, fallback: true };
  const toolsFile: MarkdownFile = tools ?? { frontmatter: {}, body: DEFAULT_TOOLS_BODY, mtime: 0, fallback: true };
  const memory: WorkspaceMemory = {
    soulMd: soul,
    memoryMd: memoryFile,
    toolsMd: toolsFile,
    wsId,
    loadedAt: Date.now(),
  };
  if (identity) memory.identityMd = identity;
  cache.set(wsId, {
    memory,
    mtimes: {
      soul: soul.mtime,
      memory: memoryFile.mtime,
      tools: toolsFile.mtime,
    },
  });
  return memory;
}

export function invalidate(wsId: string): void {
  cache.delete(wsId);
}

export function peekCache(wsId: string): WorkspaceMemory | null {
  return cache.get(wsId)?.memory ?? null;
}

export { DEFAULT_SOUL_BODY } from './memoryTypes.ts';
