// config.ts — SPEC-808 T1: vault-backed Telegram configuration.
// Stores botToken + allowedUserIds + defaultWorkspaceId under the workspace's
// keychain service. Token never leaves the vault via logs or tool_result.

import { getBest } from '../../platform/secrets/index.ts';
import { getActiveWorkspace } from '../../core/workspace.ts';
import { ErrorCode, NimbusError } from '../../observability/errors.ts';

const SERVICE_PREFIX = 'nimbus-os.';
const ACCOUNT_TOKEN = 'service:telegram:botToken';
const ACCOUNT_ALLOWED = 'service:telegram:allowedUserIds';
const ACCOUNT_DEFAULT_WS = 'service:telegram:defaultWorkspaceId';

/** Minimum plausible token length — @BotFather tokens are ~46 chars. */
const MIN_TOKEN_LEN = 10;

export interface TelegramConfigSummary {
  tokenPresent: boolean;
  allowedUserIds: number[];
  defaultWorkspaceId?: string;
}

async function resolveWsId(wsId?: string): Promise<string> {
  if (wsId) return wsId;
  const active = await getActiveWorkspace();
  if (!active) {
    throw new NimbusError(ErrorCode.U_MISSING_CONFIG, {
      reason: 'no_active_workspace',
      hint: 'run `nimbus init` first',
    });
  }
  return active.id;
}

function serviceFor(wsId: string): string {
  return `${SERVICE_PREFIX}${wsId}`;
}

export async function getTelegramBotToken(wsId?: string): Promise<string | null> {
  const store = await getBest();
  const service = serviceFor(await resolveWsId(wsId));
  try {
    const v = await store.get(service, ACCOUNT_TOKEN);
    return v && v.length >= MIN_TOKEN_LEN ? v : null;
  } catch (err) {
    // T_NOT_FOUND = legitimate "not set". Anything else (decrypt failure,
    // corrupt vault) must propagate so the caller can surface a real error
    // instead of silently reporting "no token" and then overwriting.
    if (err instanceof NimbusError && err.code === ErrorCode.T_NOT_FOUND) {
      return null;
    }
    throw err;
  }
}

export async function setTelegramBotToken(token: string, wsId?: string): Promise<void> {
  const trimmed = token.trim();
  if (trimmed.length < MIN_TOKEN_LEN) {
    throw new NimbusError(ErrorCode.U_BAD_COMMAND, {
      reason: 'invalid_telegram_token',
      hint: 'token appears too short; get a valid token from @BotFather',
    });
  }
  // Basic shape check — Telegram tokens look like `<digits>:<alphanumeric>`.
  if (!/^\d+:[A-Za-z0-9_\-]+$/.test(trimmed)) {
    throw new NimbusError(ErrorCode.U_BAD_COMMAND, {
      reason: 'invalid_telegram_token_shape',
      hint: 'expected format: 123456789:AA...',
    });
  }
  const store = await getBest();
  const service = serviceFor(await resolveWsId(wsId));
  await store.set(service, ACCOUNT_TOKEN, trimmed);
}

export async function clearTelegramBotToken(wsId?: string): Promise<void> {
  const store = await getBest();
  const service = serviceFor(await resolveWsId(wsId));
  try {
    await store.delete(service, ACCOUNT_TOKEN);
  } catch {
    // already absent — no-op
  }
}

export async function getAllowedUserIds(wsId?: string): Promise<number[]> {
  const store = await getBest();
  const service = serviceFor(await resolveWsId(wsId));
  let raw: string;
  try {
    raw = await store.get(service, ACCOUNT_ALLOWED);
  } catch (err) {
    if (err instanceof NimbusError && err.code === ErrorCode.T_NOT_FOUND) {
      return [];
    }
    throw err;
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((x) => (typeof x === 'number' && Number.isInteger(x) && x > 0 ? x : null))
      .filter((x): x is number => x !== null);
  } catch {
    // Malformed JSON — treat as empty to allow self-healing.
    return [];
  }
}

export async function setAllowedUserIds(userIds: number[], wsId?: string): Promise<void> {
  const store = await getBest();
  const service = serviceFor(await resolveWsId(wsId));
  const clean = Array.from(new Set(userIds.filter((n) => Number.isInteger(n) && n > 0))).sort(
    (a, b) => a - b,
  );
  await store.set(service, ACCOUNT_ALLOWED, JSON.stringify(clean));
}

export async function addAllowedUserId(userId: number, wsId?: string): Promise<void> {
  if (!Number.isInteger(userId) || userId <= 0) {
    throw new NimbusError(ErrorCode.U_BAD_COMMAND, {
      reason: 'invalid_telegram_user_id',
      hint: 'expected positive integer (Telegram numeric user id)',
    });
  }
  const ws = await resolveWsId(wsId);
  const existing = await getAllowedUserIds(ws);
  if (existing.includes(userId)) return;
  existing.push(userId);
  await setAllowedUserIds(existing, ws);
}

export async function removeAllowedUserId(userId: number, wsId?: string): Promise<void> {
  const ws = await resolveWsId(wsId);
  const existing = await getAllowedUserIds(ws);
  const next = existing.filter((id) => id !== userId);
  if (next.length === existing.length) return;
  await setAllowedUserIds(next, ws);
}

export async function getDefaultWorkspaceId(wsId?: string): Promise<string | null> {
  const store = await getBest();
  const service = serviceFor(await resolveWsId(wsId));
  try {
    return await store.get(service, ACCOUNT_DEFAULT_WS);
  } catch (err) {
    if (err instanceof NimbusError && err.code === ErrorCode.T_NOT_FOUND) {
      return null;
    }
    throw err;
  }
}

export async function setDefaultWorkspaceId(target: string, wsId?: string): Promise<void> {
  const store = await getBest();
  const service = serviceFor(await resolveWsId(wsId));
  await store.set(service, ACCOUNT_DEFAULT_WS, target);
}

export async function readSummary(wsId?: string): Promise<TelegramConfigSummary> {
  const ws = await resolveWsId(wsId);
  const token = await getTelegramBotToken(ws);
  const allowedUserIds = await getAllowedUserIds(ws);
  const defaultWsRaw = await getDefaultWorkspaceId(ws);
  const result: TelegramConfigSummary = {
    tokenPresent: Boolean(token),
    allowedUserIds,
  };
  if (defaultWsRaw) result.defaultWorkspaceId = defaultWsRaw;
  return result;
}

export async function clearAllTelegramConfig(wsId?: string): Promise<void> {
  const store = await getBest();
  const service = serviceFor(await resolveWsId(wsId));
  for (const acc of [ACCOUNT_TOKEN, ACCOUNT_ALLOWED, ACCOUNT_DEFAULT_WS]) {
    try {
      await store.delete(service, acc);
    } catch {
      // absent — no-op
    }
  }
}
