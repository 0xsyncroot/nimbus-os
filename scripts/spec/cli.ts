// cli.ts — `nimbus spec ...` subcommand dispatcher (SPEC-911 T5+T6)

import { parseSpec, type ParsedSpec } from './parser.ts';
import { validateSpec, getWarnings, validateDuplicateIds, type ValidationError } from './validator.ts';
import { buildIndex, writeIndex } from './indexer.ts';
import { resolveLinks } from './links.ts';
import { Glob } from 'bun';
import { resolve as resolvePath, join } from 'node:path';
import { copyFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { NimbusError, ErrorCode } from '../../src/observability/errors.ts';

const SPECS_GLOB = '**/*.spec.md';
const TEMPLATE_FEATURE = 'specs/templates/feature.spec.md';
const TEMPLATE_META = 'specs/templates/meta.spec.md';
const TEMPLATE_MODULE = 'specs/templates/module.spec.md';

const LAYER_TO_DIR: Record<string, { dir: string; idStart: number; idEnd: number }> = {
  core: { dir: 'specs/10-core', idStart: 101, idEnd: 199 },
  platform: { dir: 'specs/15-platform', idStart: 151, idEnd: 199 },
  ir: { dir: 'specs/20-ir-providers', idStart: 201, idEnd: 299 },
  providers: { dir: 'specs/20-ir-providers', idStart: 201, idEnd: 299 },
  tools: { dir: 'specs/30-tools', idStart: 301, idEnd: 399 },
  permissions: { dir: 'specs/40-permissions', idStart: 401, idEnd: 499 },
  storage: { dir: 'specs/50-storage', idStart: 501, idEnd: 599 },
  observability: { dir: 'specs/60-observability', idStart: 601, idEnd: 699 },
  cost: { dir: 'specs/70-cost', idStart: 701, idEnd: 799 },
  channels: { dir: 'specs/80-channels', idStart: 801, idEnd: 899 },
  onboard: { dir: 'specs/90-onboard', idStart: 901, idEnd: 999 },
  spec: { dir: 'specs/90-onboard', idStart: 911, idEnd: 999 },
  meta: { dir: 'specs/00-meta', idStart: 1, idEnd: 99 },
};

export async function runSpecCommand(argv: string[]): Promise<number> {
  const sub = argv[0];
  const rest = argv.slice(1);

  switch (sub) {
    case 'list':
      return await cmdList(rest);
    case 'show':
      return await cmdShow(rest);
    case 'validate':
      return await cmdValidate(rest);
    case 'index':
      return await cmdIndex(rest);
    case 'new':
      return await cmdNew(rest);
    case 'init':
      return await cmdInit();
    case undefined:
    case '--help':
    case 'help':
      printHelp();
      return 0;
    default:
      console.error(`Unknown subcommand: ${sub}`);
      printHelp();
      return 1;
  }
}

async function loadAll(specsDir = 'specs'): Promise<ParsedSpec[]> {
  const glob = new Glob(SPECS_GLOB);
  const all: ParsedSpec[] = [];
  for await (const file of glob.scan({ cwd: specsDir, absolute: true })) {
    // Skip templates (they have placeholder IDs like SPEC-XXX)
    if (file.includes('/templates/')) continue;
    try {
      const spec = await parseSpec(file);
      all.push(spec);
    } catch (err) {
      console.error(`! parse failed: ${file}`);
      if (err instanceof NimbusError) {
        console.error(`  ${err.code}: ${JSON.stringify(err.context)}`);
      }
    }
  }
  return all;
}

function statusFilter(items: ParsedSpec[], status: string | undefined): ParsedSpec[] {
  if (!status) return items;
  return items.filter((s) => s.frontmatter.status === status);
}

async function cmdList(args: string[]): Promise<number> {
  const status = parseFlag(args, '--status');
  const release = parseFlag(args, '--release');
  let all = await loadAll();
  if (status) all = statusFilter(all, status);
  if (release) all = all.filter((s) => s.frontmatter.release === release);
  all.sort((a, b) => a.frontmatter.id.localeCompare(b.frontmatter.id));

  // Print as table
  const rows = all.map((s) => ({
    id: s.frontmatter.id,
    title: s.frontmatter.title.slice(0, 50),
    status: s.frontmatter.status,
    release: s.frontmatter.release ?? '—',
    loc: s.frontmatter.estimated_loc.toString(),
  }));
  printTable(rows, ['id', 'title', 'status', 'release', 'loc']);
  console.log(`\nTotal: ${all.length} spec(s)`);
  return 0;
}

async function cmdShow(args: string[]): Promise<number> {
  const id = args[0];
  if (!id) {
    console.error('usage: nimbus spec show <SPEC-XXX>');
    return 1;
  }
  const all = await loadAll();
  const spec = all.find((s) => s.frontmatter.id === id);
  if (!spec) {
    console.error(`Not found: ${id}`);
    return 2;
  }
  console.log(`# ${spec.frontmatter.id} — ${spec.frontmatter.title}`);
  console.log(`Status: ${spec.frontmatter.status} | Release: ${spec.frontmatter.release ?? '—'}`);
  console.log(`Path: ${spec.path}`);
  console.log(`Depends on: ${spec.frontmatter.depends_on.join(', ') || '—'}`);
  console.log(`Files: ${spec.frontmatter.files_touched.join(', ') || '—'}`);
  console.log('');
  console.log(spec.body);
  return 0;
}

async function cmdValidate(args: string[]): Promise<number> {
  const target = args[0];
  const all = await loadAll();
  const targets = target
    ? all.filter((s) => s.frontmatter.id === target || s.path.endsWith(target))
    : all;
  if (targets.length === 0) {
    console.error('No specs found to validate');
    return 2;
  }

  // Rule 11: batch duplicate-ID check across the entire collection (not per-target)
  const dupeErrors = validateDuplicateIds(all);
  // Build a map so we can attach dupe errors to the right target
  const dupeByPath = new Map<string, ValidationError[]>();
  for (const e of dupeErrors) {
    const list = dupeByPath.get(e.path) ?? [];
    list.push(e);
    dupeByPath.set(e.path, list);
  }

  let totalErrors = 0;
  let totalWarnings = 0;
  for (const spec of targets) {
    const errors = [...validateSpec(spec, all), ...(dupeByPath.get(spec.path) ?? [])];
    const warnings = getWarnings(spec);
    if (errors.length === 0 && warnings.length === 0) {
      console.log(`✓ ${spec.frontmatter.id}  ${spec.path}`);
      continue;
    }
    console.log(`✗ ${spec.frontmatter.id}  ${spec.path}`);
    for (const e of errors) {
      console.log(`  rule ${e.rule}: ${e.code}`);
      totalErrors++;
    }
    for (const w of warnings) {
      console.log(`  warn ${w.rule}: ${w.code}`);
      totalWarnings++;
    }
  }
  console.log(`\nValidated ${targets.length} spec(s): ${totalErrors} error(s), ${totalWarnings} warning(s)`);
  return totalErrors > 0 ? 1 : 0;
}

async function cmdIndex(_args: string[]): Promise<number> {
  const all = await loadAll();
  const content = buildIndex(all);
  const indexPath = resolvePath('specs/_index.md');
  await writeIndex(indexPath, content);
  console.log(`✓ Indexed ${all.length} spec(s) → ${indexPath}`);
  return 0;
}

async function cmdNew(args: string[]): Promise<number> {
  const layer = args[0];
  const name = args[1];
  if (!layer || !name) {
    console.error('usage: nimbus spec new <layer> <kebab-name>');
    return 1;
  }
  const config = LAYER_TO_DIR[layer];
  if (!config) {
    console.error(`Unknown layer: ${layer}. Valid: ${Object.keys(LAYER_TO_DIR).join(', ')}`);
    return 1;
  }

  const all = await loadAll();
  const isMeta = layer === 'meta';
  const prefix = isMeta ? 'META' : 'SPEC';
  const used = new Set(
    all
      .filter((s) => s.frontmatter.id.startsWith(`${prefix}-`))
      .map((s) => parseInt(s.frontmatter.id.split('-')[1] ?? '0', 10)),
  );

  let nextId = config.idStart;
  while (used.has(nextId) && nextId <= config.idEnd) nextId++;
  if (nextId > config.idEnd) {
    console.error(`No free IDs in range ${config.idStart}-${config.idEnd}`);
    return 1;
  }

  const idStr = `${prefix}-${String(nextId).padStart(3, '0')}`;
  const filename = `${idStr}-${name}.spec.md`;
  const targetPath = join(config.dir, filename);

  if (existsSync(targetPath)) {
    console.error(`Already exists: ${targetPath}`);
    return 1;
  }

  await mkdir(config.dir, { recursive: true });
  const tmpl = isMeta ? TEMPLATE_META : TEMPLATE_FEATURE;
  if (!existsSync(tmpl)) {
    console.error(`Template not found: ${tmpl}`);
    return 3;
  }
  await copyFile(tmpl, targetPath);
  console.log(`✓ Created ${targetPath}`);
  console.log(`  Edit and replace SPEC-XXX → ${idStr} in frontmatter`);
  return 0;
}

async function cmdInit(): Promise<number> {
  const dirs = [
    'specs/00-meta',
    'specs/10-core',
    'specs/15-platform',
    'specs/20-ir-providers',
    'specs/30-tools',
    'specs/40-permissions',
    'specs/50-storage',
    'specs/60-observability',
    'specs/70-cost',
    'specs/80-channels',
    'specs/90-onboard',
    'specs/templates',
  ];
  for (const d of dirs) {
    await mkdir(d, { recursive: true });
  }
  console.log(`✓ Spec directory structure ready`);
  console.log(`  Templates: ${TEMPLATE_FEATURE}, ${TEMPLATE_META}, ${TEMPLATE_MODULE}`);
  return 0;
}

function printHelp(): void {
  console.log(`Usage: nimbus spec <command> [args]

Commands:
  init                            Bootstrap specs/ directory structure
  new <layer> <kebab-name>        Scaffold new spec from template
  list [--status=X] [--release=Y] List specs
  show <SPEC-XXX>                 Show full spec
  validate [<SPEC-XXX>|<path>]    Validate one or all
  index                           Regenerate specs/_index.md

Layers: ${Object.keys(LAYER_TO_DIR).join(', ')}

Exit codes: 0 ok, 1 validation error, 2 not found, 3 internal error
`);
}

function parseFlag(args: string[], name: string): string | undefined {
  for (const a of args) {
    if (a.startsWith(`${name}=`)) return a.slice(name.length + 1);
  }
  return undefined;
}

function printTable(rows: Record<string, string>[], columns: string[]): void {
  if (rows.length === 0) {
    console.log('(empty)');
    return;
  }
  const widths: Record<string, number> = {};
  for (const c of columns) {
    widths[c] = Math.max(c.length, ...rows.map((r) => (r[c] ?? '').length));
  }
  const sep = columns.map((c) => '-'.repeat(widths[c] ?? 0)).join('-+-');
  const header = columns.map((c) => c.padEnd(widths[c] ?? 0)).join(' | ');
  console.log(header);
  console.log(sep);
  for (const r of rows) {
    console.log(columns.map((c) => (r[c] ?? '').padEnd(widths[c] ?? 0)).join(' | '));
  }
}

// Suppress lint for unused import
void resolveLinks;
