// installer.ts — SPEC-804 T_auth + T2: Slack OAuth install flow + HMAC-signed state.
// - Generates HMAC-SHA256 state parameter (CSRF defence, 5-min TTL).
// - Exchanges OAuth code for bot + app-level tokens.
// - Stores tokens in SPEC-152 vault (never written to plaintext config).

import { createHmac, timingSafeEqual } from 'node:crypto';
import { getBest } from '../../platform/secrets/index.ts';
import { logger } from '../../observability/logger.ts';
import { ErrorCode, NimbusError } from '../../observability/errors.ts';

/** Result of a successful OAuth install. */
export interface InstallResult {
  botToken: string;
  appToken: string;
  teamId: string;
}

/** Slack OAuth token exchange response (subset). */
interface SlackOAuthV2Response {
  ok: boolean;
  error?: string;
  access_token?: string; // bot token (xoxb-)
  app_id?: string;
  team?: { id: string; name: string };
  authed_user?: { access_token?: string };
}

/** State parameter TTL in milliseconds (5 minutes). */
const STATE_TTL_MS = 5 * 60 * 1000;
/** Separator used in state payload. */
const STATE_SEP = '.';

/**
 * Generate an HMAC-SHA256 signed state parameter for OAuth CSRF protection.
 * Format: `base64url(nonce) . expiresAt . hmac(secret, nonce + expiresAt)`.
 */
export function generateOAuthState(installSecret: string): string {
  const nonce = crypto.getRandomValues(new Uint8Array(16));
  const nonceB64 = Buffer.from(nonce).toString('base64url');
  const expiresAt = Date.now() + STATE_TTL_MS;
  const payload = `${nonceB64}${STATE_SEP}${expiresAt}`;
  const mac = createHmac('sha256', installSecret).update(payload).digest('base64url');
  return `${payload}${STATE_SEP}${mac}`;
}

/**
 * Verify an HMAC-SHA256 signed OAuth state parameter.
 * Returns `{valid: true}` or `{valid: false, reason}`.
 */
export function verifyOAuthState(
  state: string,
  installSecret: string,
): { valid: true } | { valid: false; reason: string } {
  try {
    const parts = state.split(STATE_SEP);
    if (parts.length !== 3) return { valid: false, reason: 'malformed_state' };
    const [nonceB64, expiresAtStr, mac] = parts as [string, string, string];
    const expiresAt = Number(expiresAtStr);
    if (Number.isNaN(expiresAt)) return { valid: false, reason: 'invalid_expires' };
    if (Date.now() > expiresAt) return { valid: false, reason: 'state_expired' };

    const payload = `${nonceB64}${STATE_SEP}${expiresAt}`;
    const expectedMac = createHmac('sha256', installSecret).update(payload).digest('base64url');

    // Compare on the base64url string form (not decoded bytes) to reject
    // non-canonical encodings — e.g., flipping the 2 "padding" bits in the
    // trailing char of a 43-char SHA256 base64url digest decodes to the same
    // 32 bytes, so byte-level timingSafeEqual would accept tampered input.
    // `expectedMac` is always canonical (Node's `.digest('base64url')`), so any
    // byte-level change to the MAC segment produces a different string here.
    const macStrBuf = Buffer.from(mac, 'utf8');
    const expectedStrBuf = Buffer.from(expectedMac, 'utf8');
    if (macStrBuf.length !== expectedStrBuf.length) return { valid: false, reason: 'mac_length_mismatch' };
    if (!timingSafeEqual(macStrBuf, expectedStrBuf)) return { valid: false, reason: 'mac_mismatch' };

    return { valid: true };
  } catch {
    return { valid: false, reason: 'verification_exception' };
  }
}

/**
 * Exchange an OAuth `code` for bot + app tokens and persist to vault.
 * Throws `NimbusError` on Slack API error or vault write failure.
 */
export async function runOAuthInstall(
  code: string,
  clientId: string,
  clientSecret: string,
  redirectUri?: string,
): Promise<InstallResult> {
  const params = new URLSearchParams({ code, client_id: clientId, client_secret: clientSecret });
  if (redirectUri) params.set('redirect_uri', redirectUri);

  const resp = await fetch('https://slack.com/api/oauth.v2.access', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });

  if (!resp.ok) {
    throw new NimbusError(ErrorCode.P_NETWORK, {
      reason: 'slack_oauth_http_error',
      status: resp.status,
    });
  }

  const data = (await resp.json()) as SlackOAuthV2Response;
  if (!data.ok || !data.access_token || !data.team?.id) {
    throw new NimbusError(ErrorCode.P_AUTH, {
      reason: 'slack_oauth_failed',
      slackError: data.error,
    });
  }

  const botToken = data.access_token;
  // App-level token (xapp-) must be pre-configured; OAuth v2 doesn't return it.
  // Callers must store appToken separately or pass it in config.
  const appToken = data.authed_user?.access_token ?? '';
  const teamId = data.team.id;

  // Persist tokens to SPEC-152 vault (never to plaintext config).
  const store = await getBest();
  await store.set('nimbus', 'slack.botToken', botToken);
  if (appToken) {
    await store.set('nimbus', 'slack.appToken', appToken);
  }
  await store.set('nimbus', 'slack.teamId', teamId);

  logger.info({ teamId }, 'slack: OAuth install complete, tokens stored in vault');

  return { botToken, appToken, teamId };
}
