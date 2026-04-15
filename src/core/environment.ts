// environment.ts — SPEC-109: minimal per-turn environment snapshot for prompt injection.

export interface EnvironmentSnapshot {
  cwd: string;
  gitBranch?: string;
  gitDirty?: boolean;
  nowIso: string;
  lastFailedToolName?: string;
}

export interface SnapshotContext {
  clock?: { now(): number };
  abort?: AbortSignal;
  lastFailedToolName?: string;
  cwd?: string;
  gitProbe?: (cwd: string, timeoutMs: number, abort?: AbortSignal) => Promise<{ branch?: string; dirty?: boolean }>;
}

export const GIT_PROBE_TIMEOUT_MS = 100;
export const CWD_MAX_BYTES = 4096;

async function defaultGitProbe(
  cwd: string,
  timeoutMs: number,
  abort?: AbortSignal,
): Promise<{ branch?: string; dirty?: boolean }> {
  const result: { branch?: string; dirty?: boolean } = {};
  const deadline = Date.now() + timeoutMs;
  try {
    const ctrl = new AbortController();
    if (abort) {
      abort.addEventListener('abort', () => ctrl.abort(), { once: true });
    }
    const timer = setTimeout(() => ctrl.abort(), Math.max(1, deadline - Date.now()));
    try {
      const branchProc = Bun.spawn(['git', 'rev-parse', '--abbrev-ref', 'HEAD'], {
        cwd,
        stdout: 'pipe',
        stderr: 'ignore',
      });
      const [branchText, exit] = await Promise.all([
        new Response(branchProc.stdout).text(),
        branchProc.exited,
      ]);
      if (exit === 0) {
        const b = branchText.trim();
        if (b.length > 0) result.branch = b;
      }
    } finally {
      clearTimeout(timer);
    }
    if (result.branch === undefined) return result;
    const remaining = Math.max(1, deadline - Date.now());
    const ctrl2 = new AbortController();
    const timer2 = setTimeout(() => ctrl2.abort(), remaining);
    try {
      const statusProc = Bun.spawn(['git', 'status', '--porcelain'], {
        cwd,
        stdout: 'pipe',
        stderr: 'ignore',
      });
      const [statusText, exit2] = await Promise.all([
        new Response(statusProc.stdout).text(),
        statusProc.exited,
      ]);
      if (exit2 === 0) {
        result.dirty = statusText.trim().length > 0;
      }
    } finally {
      clearTimeout(timer2);
    }
  } catch {
    // swallow: git probe absence is OK
  }
  return result;
}

export async function snapshotEnvironment(ctx?: SnapshotContext): Promise<EnvironmentSnapshot> {
  const now = ctx?.clock?.now ? ctx.clock.now() : Date.now();
  const cwd = ctx?.cwd ?? process.cwd();
  const probe = ctx?.gitProbe ?? defaultGitProbe;
  let gitBranch: string | undefined;
  let gitDirty: boolean | undefined;
  try {
    const res = await probe(cwd, GIT_PROBE_TIMEOUT_MS, ctx?.abort);
    if (res.branch !== undefined) gitBranch = res.branch;
    if (res.dirty !== undefined) gitDirty = res.dirty;
  } catch {
    // leave undefined
  }
  const snap: EnvironmentSnapshot = {
    cwd: truncateCwd(cwd),
    nowIso: new Date(now).toISOString(),
  };
  if (gitBranch !== undefined) snap.gitBranch = gitBranch;
  if (gitDirty !== undefined) snap.gitDirty = gitDirty;
  if (ctx?.lastFailedToolName) snap.lastFailedToolName = ctx.lastFailedToolName;
  return snap;
}

function truncateCwd(p: string): string {
  const bytes = Buffer.byteLength(p, 'utf8');
  if (bytes <= CWD_MAX_BYTES) return p;
  // naive truncation preserving suffix prefix byte-budget
  return p.slice(0, CWD_MAX_BYTES - 3) + '...';
}

function xmlEscape(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function serializeEnvironment(snap: EnvironmentSnapshot): string {
  const lines: string[] = ['<environment>'];
  lines.push(`  <cwd>${xmlEscape(snap.cwd)}</cwd>`);
  if (snap.gitBranch !== undefined) {
    const dirtyAttr = snap.gitDirty === undefined ? '' : ` dirty="${snap.gitDirty ? 'true' : 'false'}"`;
    lines.push(`  <git branch="${xmlEscape(snap.gitBranch)}"${dirtyAttr}/>`);
  }
  lines.push(`  <now>${xmlEscape(snap.nowIso)}</now>`);
  if (snap.lastFailedToolName) {
    lines.push(`  <lastFailedTool>${xmlEscape(snap.lastFailedToolName)}</lastFailedTool>`);
  }
  lines.push('</environment>');
  return lines.join('\n');
}
