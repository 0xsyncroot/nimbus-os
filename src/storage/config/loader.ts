// loader.ts — SPEC-501: 6-layer config loader with JSON-pointer error paths.

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { configDir } from '../../platform/paths.ts';
import { ErrorCode, NimbusError } from '../../observability/errors.ts';
import {
  NIMBUS_CONFIG_DEFAULTS,
  NimbusConfigSchema,
  PartialNimbusConfigSchema,
  type ConfigLayer,
  type ConfigMergeTrace,
  type NimbusConfig,
  type PartialNimbusConfig,
} from './schema.ts';
import { mergeLayers, type LayerInput } from './merge.ts';
import {
  readActiveProfile,
  readProfile,
  createProfile,
  deleteProfile,
  listProfiles,
  switchProfile,
} from './profiles.ts';

export interface ConfigLoader {
  loadConfig(
    cliFlags: Record<string, unknown>,
    workspaceRoot?: string,
  ): Promise<NimbusConfig>;
  loadConfigWithTrace(
    cliFlags: Record<string, unknown>,
    workspaceRoot?: string,
  ): Promise<{ config: NimbusConfig; trace: ConfigMergeTrace[] }>;
  listProfiles(): Promise<string[]>;
  createProfile(name: string, base?: PartialNimbusConfig): Promise<void>;
  deleteProfile(name: string): Promise<void>;
  switchProfile(name: string): Promise<void>;
}

function userConfigPath(): string {
  return join(configDir(), 'config.json');
}

async function readAndParseJson(
  path: string,
  layer: ConfigLayer,
): Promise<PartialNimbusConfig> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch {
    return {};
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    throw new NimbusError(
      ErrorCode.S_CONFIG_INVALID,
      { reason: 'json_parse', layer, path },
      err instanceof Error ? err : undefined,
    );
  }
  const result = PartialNimbusConfigSchema.safeParse(json);
  if (!result.success) {
    throw configIssue(result.error, layer, path);
  }
  return result.data;
}

function configIssue(
  err: z.ZodError,
  layer: ConfigLayer,
  path: string | undefined,
): NimbusError {
  return new NimbusError(ErrorCode.S_CONFIG_INVALID, {
    layer,
    path,
    issues: err.issues.map((i) => ({
      pointer: '/' + i.path.map(String).join('/'),
      message: i.message,
    })),
  });
}

/**
 * Path guard — reject env/workspace-provided paths that try to escape into
 * sensitive system roots (defence in depth; config values are not file paths
 * today but schema is forward-looking).
 */
const FORBIDDEN_PATH_PREFIXES = ['/etc/', '/root/.ssh/', '/private/etc/'];
function assertNoTraversal(data: PartialNimbusConfig, layer: ConfigLayer): void {
  const s = JSON.stringify(data);
  for (const pfx of FORBIDDEN_PATH_PREFIXES) {
    if (s.includes(pfx)) {
      throw new NimbusError(ErrorCode.X_PATH_BLOCKED, {
        reason: 'forbidden_path_prefix',
        prefix: pfx,
        layer,
      });
    }
  }
}

// --- Env layer --------------------------------------------------------------

function envLayer(): PartialNimbusConfig {
  const env = process.env;
  const out: PartialNimbusConfig = {};
  const provider: Record<string, unknown> = {};
  if (env['NIMBUS_PROVIDER']) provider['default'] = env['NIMBUS_PROVIDER'];
  if (env['NIMBUS_MODEL']) provider['model'] = env['NIMBUS_MODEL'];
  if (Object.keys(provider).length) (out as Record<string, unknown>)['provider'] = provider;

  const permissions: Record<string, unknown> = {};
  if (env['NIMBUS_PERMISSION_MODE']) {
    permissions['mode'] = env['NIMBUS_PERMISSION_MODE'];
  }
  if (Object.keys(permissions).length) {
    (out as Record<string, unknown>)['permissions'] = permissions;
  }

  const logging: Record<string, unknown> = {};
  if (env['NIMBUS_LOG_LEVEL']) logging['level'] = env['NIMBUS_LOG_LEVEL'];
  if (Object.keys(logging).length) (out as Record<string, unknown>)['logging'] = logging;

  if (env['NIMBUS_PROFILE']) out.profile = env['NIMBUS_PROFILE'];

  const parsed = PartialNimbusConfigSchema.safeParse(out);
  if (!parsed.success) throw configIssue(parsed.error, 'env', undefined);
  return parsed.data;
}

// --- CLI layer --------------------------------------------------------------

function cliLayer(flags: Record<string, unknown>): PartialNimbusConfig {
  const out: PartialNimbusConfig = {};
  const provider: Record<string, unknown> = {};
  if (typeof flags['provider'] === 'string') provider['default'] = flags['provider'];
  if (typeof flags['model'] === 'string') provider['model'] = flags['model'];
  if (Object.keys(provider).length) (out as Record<string, unknown>)['provider'] = provider;

  if (typeof flags['permissionMode'] === 'string') {
    (out as Record<string, unknown>)['permissions'] = { mode: flags['permissionMode'] };
  }
  if (typeof flags['logLevel'] === 'string') {
    (out as Record<string, unknown>)['logging'] = { level: flags['logLevel'] };
  }
  if (typeof flags['profile'] === 'string') out.profile = flags['profile'];

  const parsed = PartialNimbusConfigSchema.safeParse(out);
  if (!parsed.success) throw configIssue(parsed.error, 'cli', undefined);
  return parsed.data;
}

// --- Public API -------------------------------------------------------------

export async function loadConfig(
  cliFlags: Record<string, unknown> = {},
  workspaceRoot?: string,
): Promise<NimbusConfig> {
  const { config } = await loadConfigWithTrace(cliFlags, workspaceRoot);
  return config;
}

export async function loadConfigWithTrace(
  cliFlags: Record<string, unknown> = {},
  workspaceRoot?: string,
): Promise<{ config: NimbusConfig; trace: ConfigMergeTrace[] }> {
  const defaults: PartialNimbusConfig = NIMBUS_CONFIG_DEFAULTS;
  const user = await readAndParseJson(userConfigPath(), 'user');
  assertNoTraversal(user, 'user');

  const env = envLayer();
  const cli = cliLayer(cliFlags);

  // Determine profile: CLI > env > user (profile field inside user config).
  const profileName =
    (typeof cli.profile === 'string' && cli.profile) ||
    (typeof env.profile === 'string' && env.profile) ||
    (typeof user.profile === 'string' && user.profile) ||
    (await readActiveProfile());

  const profile: PartialNimbusConfig =
    profileName && typeof profileName === 'string'
      ? await readProfile(profileName)
      : {};

  const workspace: PartialNimbusConfig = workspaceRoot
    ? await readAndParseJson(join(workspaceRoot, 'nimbus.config.json'), 'workspace')
    : {};
  assertNoTraversal(workspace, 'workspace');

  // Order: lowest → highest precedence.
  const layers: LayerInput[] = [
    { source: 'default', data: defaults },
    { source: 'user', data: user },
    { source: 'profile', data: profile },
    { source: 'workspace', data: workspace },
    { source: 'env', data: env },
    { source: 'cli', data: cli },
  ];

  const { merged, trace } = mergeLayers(layers);

  // Final validation — any missing required field / bad enum fails here
  // with JSON-pointer reporting.
  const parsed = NimbusConfigSchema.safeParse(merged);
  if (!parsed.success) throw configIssue(parsed.error, 'user', userConfigPath());
  return { config: parsed.data, trace };
}

export async function writeUserConfig(config: PartialNimbusConfig): Promise<void> {
  const parsed = PartialNimbusConfigSchema.safeParse(config);
  if (!parsed.success) throw configIssue(parsed.error, 'user', userConfigPath());
  const dir = configDir();
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const path = userConfigPath();
  const tmp = `${path}.tmp.${process.pid}.${Date.now()}`;
  await writeFile(tmp, JSON.stringify(parsed.data, null, 2), {
    encoding: 'utf8',
    mode: 0o600,
  });
  await rename(tmp, path);
}

export const configLoader: ConfigLoader = {
  loadConfig,
  loadConfigWithTrace,
  listProfiles,
  createProfile,
  deleteProfile,
  switchProfile,
};
