// adapter.ts — SPEC-804 T3+T4: Slack channel adapter via Socket Mode + Web API.
// Uses Slack Web API + Socket Mode (wss://) directly — no @slack/bolt required at runtime.
// Unknown userId → silent drop + security event. Rate-limited at Tier-2 (20 req/min).

import { logger } from '../../observability/logger.ts';
import { ErrorCode, NimbusError } from '../../observability/errors.ts';
import { getGlobalBus } from '../../core/events.ts';
import { TOPICS } from '../../core/eventTypes.ts';
import type { ChannelAdapter, NativeFormat } from '../ChannelAdapter.ts';
import { createRateLimiter } from '../common/rateLimiter.ts';
import { slackEventToInbound, textToSlackMrkdwn, type SlackMessageEvent } from './serde.ts';
import { getBest } from '../../platform/secrets/index.ts';
import { buildApprovalBlocks } from './draftEdit.ts';

export interface SlackAdapterConfig {
  /** Slack user IDs allowed to reach the agent (format: `U0XXXXXXXX`). */
  readonly allowedUserIds: string[];
  /** Map Slack channel ID → nimbus workspaceId. */
  readonly channelWorkspaceMapping: Record<string, string>;
  /** Pre-loaded bot token (xoxb-). If absent, loaded from vault at start(). */
  readonly botToken?: string;
  /** Pre-loaded app-level token (xapp-). If absent, loaded from vault at start(). */
  readonly appToken?: string;
}

/** Slack userId format: U followed by ≥8 alphanumeric chars. */
const VALID_SLACK_USER_RE = /^U[A-Z0-9]{8,}$/;
/** Slack Web API base URL. */
const SLACK_API_BASE = 'https://slack.com/api';
/** Rate limit: Slack Tier-2 = 20 requests per minute → ~0.33/sec. */
const SLACK_RATE_CAPACITY = 20;
const SLACK_RATE_REFILL_PER_SEC = 20 / 60;

/** Envelope wrapping a Slack Socket Mode event payload. */
interface SocketEnvelope {
  envelope_id: string;
  type: 'events_api' | 'hello' | 'disconnect';
  payload?: {
    event?: SlackMessageEvent & { user?: string; channel?: string; bot_id?: string };
    actions?: Array<{
      action_id?: string;
      value?: string;
      type?: string;
    }>;
    type?: string;
  };
  accepts_response_payload?: boolean;
}

export function createSlackAdapter(cfg: SlackAdapterConfig): ChannelAdapter {
  let botToken: string | null = cfg.botToken ?? null;
  let appToken: string | null = cfg.appToken ?? null;
  let running = false;
  let ws: WebSocket | null = null;

  // Slack Tier-2: 20 req/min per method.
  const rateLimiter = createRateLimiter({
    capacity: SLACK_RATE_CAPACITY,
    refillRatePerSec: SLACK_RATE_REFILL_PER_SEC,
  });

  async function apiPost<T>(method: string, body: Record<string, unknown>): Promise<T> {
    const waitMs = rateLimiter.consume(1);
    if (waitMs > 0) await new Promise((r) => setTimeout(r, waitMs));

    const resp = await fetch(`${SLACK_API_BASE}/${method}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${botToken}`,
        'Content-Type': 'application/json; charset=utf-8',
      },
      body: JSON.stringify(body),
    });
    if (!resp.ok) {
      throw new NimbusError(ErrorCode.P_NETWORK, {
        reason: 'slack_api_http_error',
        status: resp.status,
        method,
      });
    }
    const data = (await resp.json()) as { ok: boolean; error?: string } & T;
    if (!data.ok) {
      throw new NimbusError(ErrorCode.P_NETWORK, {
        reason: 'slack_api_error',
        method,
        slackError: data.error,
      });
    }
    return data;
  }

  async function getSocketUrl(): Promise<string> {
    const result = await fetch(`${SLACK_API_BASE}/apps.connections.open`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${appToken}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
    });
    if (!result.ok) {
      throw new NimbusError(ErrorCode.P_NETWORK, {
        reason: 'slack_socket_open_failed',
        status: result.status,
      });
    }
    const json = (await result.json()) as { ok: boolean; url?: string; error?: string };
    if (!json.ok || !json.url) {
      throw new NimbusError(ErrorCode.P_AUTH, {
        reason: 'slack_socket_no_url',
        slackError: json.error,
      });
    }
    return json.url;
  }

  function handleEnvelope(raw: string): void {
    let envelope: SocketEnvelope;
    try {
      envelope = JSON.parse(raw) as SocketEnvelope;
    } catch {
      logger.warn('slack: malformed socket envelope, skipping');
      return;
    }

    // Acknowledge the envelope immediately (Slack requires this within 3s).
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ envelope_id: envelope.envelope_id }));
    }

    if (envelope.type === 'hello') {
      logger.info('slack: socket mode connected');
      return;
    }

    if (envelope.type === 'disconnect') {
      logger.warn('slack: server requested disconnect, reconnecting');
      reconnect();
      return;
    }

    if (envelope.type !== 'events_api') return;

    const event = envelope.payload?.event;
    if (!event || event.type !== 'message') return;
    // Ignore bot messages to avoid loops.
    if (event.bot_id) return;

    const slackUserId = event.user ?? '';

    // Validate userId format.
    if (!VALID_SLACK_USER_RE.test(slackUserId)) {
      logger.warn({ slackUserId }, 'slack: invalid userId format, dropping');
      return;
    }

    if (!cfg.allowedUserIds.includes(slackUserId)) {
      // Security: silent drop + publish security event (no reply to unknown users).
      logger.warn({ adapterId: 'slack', userId: slackUserId }, 'slack: unauthorized user dropped');
      getGlobalBus().publish(TOPICS.security.event, {
        type: 'security.event',
        adapterId: 'slack',
        reason: 'unauthorized_slack_user',
        userId: slackUserId,
        ts: Date.now(),
      });
      return;
    }

    const channelId = event.channel ?? '';
    const workspaceId = cfg.channelWorkspaceMapping[channelId];
    if (!workspaceId) {
      logger.warn({ channelId }, 'slack: no workspace mapping for channel, dropping');
      return;
    }

    const inboundEvent = slackEventToInbound(event, workspaceId);
    getGlobalBus().publish(TOPICS.channel.inbound, inboundEvent);
  }

  function connectWebSocket(socketUrl: string): void {
    ws = new WebSocket(socketUrl);

    ws.onopen = () => {
      logger.info('slack: WebSocket opened');
    };

    ws.onmessage = (msg: MessageEvent<string>) => {
      handleEnvelope(msg.data);
    };

    ws.onerror = (err) => {
      logger.warn({ err }, 'slack: WebSocket error');
    };

    ws.onclose = () => {
      if (running) {
        logger.warn('slack: WebSocket closed unexpectedly, scheduling reconnect');
        setTimeout(() => reconnect(), 5000);
      }
    };
  }

  function reconnect(): void {
    if (!running) return;
    if (ws) {
      ws.onclose = null; // prevent double-reconnect
      ws.close();
      ws = null;
    }
    getSocketUrl()
      .then((url) => connectWebSocket(url))
      .catch((err) => {
        logger.error({ err }, 'slack: reconnect failed, retrying in 10s');
        setTimeout(() => reconnect(), 10_000);
      });
  }

  return {
    id: 'slack',
    kind: 'slack' as const,
    nativeFormat: 'slack-mrkdwn' as NativeFormat,
    capabilities: { nativeFormat: 'slack-mrkdwn' as NativeFormat },

    async start(): Promise<void> {
      if (!botToken) {
        const store = await getBest();
        botToken = await store.get('nimbus', 'slack.botToken');
      }
      if (!appToken) {
        const store = await getBest();
        appToken = await store.get('nimbus', 'slack.appToken');
      }
      if (!botToken || !appToken) {
        throw new NimbusError(ErrorCode.U_MISSING_CONFIG, {
          reason: 'slack_tokens_missing',
          hint: 'Run: nimbus slack install',
        });
      }
      running = true;
      const socketUrl = await getSocketUrl();
      connectWebSocket(socketUrl);
      logger.info('slack: adapter started (Socket Mode)');
    },

    async stop(): Promise<void> {
      running = false;
      if (ws) {
        ws.onclose = null;
        ws.close();
        ws = null;
      }
      logger.info('slack: adapter stopped');
    },

    async send(workspaceId: string, text: string): Promise<void> {
      // Reverse lookup: find Slack channel for this workspaceId.
      const entry = Object.entries(cfg.channelWorkspaceMapping).find(([, ws]) => ws === workspaceId);
      if (!entry) {
        logger.warn({ workspaceId }, 'slack: no channel mapping for workspaceId, cannot send');
        return;
      }
      const channelId = entry[0];
      await apiPost('chat.postMessage', {
        channel: channelId,
        text: textToSlackMrkdwn(text),
        mrkdwn: true,
      });
    },
  };
}

export { buildApprovalBlocks };
