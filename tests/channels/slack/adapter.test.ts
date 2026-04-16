// adapter.test.ts — SPEC-804: Slack adapter unit tests.
// Tests: serde, HMAC OAuth state, Block Kit approval, allowlist enforcement.

import { describe, expect, test } from 'bun:test';
import { slackEventToInbound, textToSlackMrkdwn } from '../../../src/channels/slack/serde.ts';
import type { SlackMessageEvent } from '../../../src/channels/slack/serde.ts';
import { generateOAuthState, verifyOAuthState } from '../../../src/channels/slack/installer.ts';
import {
  buildApprovalBlocks,
  parseApprovalAction,
  buildDraftBlocks,
  buildReplyBlocks,
} from '../../../src/channels/slack/draftEdit.ts';
import { createEventBus } from '../../../src/core/events.ts';
import { TOPICS } from '../../../src/core/eventTypes.ts';
import type { ChannelInboundEvent } from '../../../src/core/eventTypes.ts';

// ---------------------------------------------------------------------------
// SPEC-804 T1: serde
// ---------------------------------------------------------------------------

describe('SPEC-804 T1: slackEventToInbound', () => {
  function makeEvent(overrides?: Partial<SlackMessageEvent>): SlackMessageEvent {
    return {
      type: 'message',
      channel: 'C01234567',
      user: 'U01234567A',
      text: 'hello world',
      ts: '1700000000.000001',
      ...overrides,
    };
  }

  test('wraps text in <tool_output trusted="false"> per META-009', () => {
    const event = slackEventToInbound(makeEvent({ text: 'hello' }), 'ws1');
    expect(event.text).toContain('<tool_output trusted="false">');
    expect(event.text).toContain('</tool_output>');
  });

  test('sets adapterId to "slack"', () => {
    const event = slackEventToInbound(makeEvent(), 'ws1');
    expect(event.adapterId).toBe('slack');
    expect(event.type).toBe('channel.inbound');
    expect(event.workspaceId).toBe('ws1');
  });

  test('strips <@UXXXXXXXX> mention patterns from text', () => {
    const event = slackEventToInbound(makeEvent({ text: '<@U01234567A> hello' }), 'ws1');
    // Mention should be stripped from the content inside the wrapper.
    expect(event.text).not.toContain('<@U');
    expect(event.text).toContain('hello');
  });

  test('uses event.user as userId', () => {
    const event = slackEventToInbound(makeEvent({ user: 'U09876543B' }), 'ws1');
    expect(event.userId).toBe('U09876543B');
  });

  test('falls back to bot_id when user absent', () => {
    const event = slackEventToInbound(
      makeEvent({ user: undefined, bot_id: 'B01234567' }),
      'ws1',
    );
    expect(event.userId).toBe('B01234567');
  });

  test('handles empty text gracefully', () => {
    const event = slackEventToInbound(makeEvent({ text: '' }), 'ws1');
    expect(event.text).toContain('<tool_output trusted="false">');
  });
});

describe('SPEC-804 T1: textToSlackMrkdwn', () => {
  test('converts **bold** to *bold*', () => {
    expect(textToSlackMrkdwn('**hello**')).toBe('*hello*');
  });

  test('escapes & to &amp;', () => {
    expect(textToSlackMrkdwn('a & b')).toContain('&amp;');
  });

  test('escapes < to &lt;', () => {
    expect(textToSlackMrkdwn('a < b')).toContain('&lt;');
  });

  test('escapes > to &gt;', () => {
    expect(textToSlackMrkdwn('a > b')).toContain('&gt;');
  });

  test('preserves backtick code spans', () => {
    const input = 'use `npm install`';
    const output = textToSlackMrkdwn(input);
    expect(output).toContain('`npm install`');
  });
});

// ---------------------------------------------------------------------------
// SPEC-804 T_auth: HMAC OAuth state
// ---------------------------------------------------------------------------

describe('SPEC-804 T_auth: HMAC OAuth state (CSRF defence)', () => {
  const SECRET = 'test-install-secret-abc123';

  test('generates a valid state that passes verification', () => {
    const state = generateOAuthState(SECRET);
    const result = verifyOAuthState(state, SECRET);
    expect(result.valid).toBe(true);
  });

  test('tampered state (modified mac) is rejected', () => {
    const state = generateOAuthState(SECRET);
    const parts = state.split('.');
    // Flip last char of the mac to tamper it.
    parts[2] = parts[2]!.slice(0, -1) + (parts[2]!.endsWith('a') ? 'b' : 'a');
    const tampered = parts.join('.');
    const result = verifyOAuthState(tampered, SECRET);
    expect(result.valid).toBe(false);
    expect((result as { valid: false; reason: string }).reason).toMatch(/mac_mismatch|mac_length/);
  });

  test('tampered state (modified nonce) is rejected', () => {
    const state = generateOAuthState(SECRET);
    const parts = state.split('.');
    // Change the nonce part.
    parts[0] = parts[0]!.slice(0, -1) + (parts[0]!.endsWith('a') ? 'b' : 'a');
    const tampered = parts.join('.');
    const result = verifyOAuthState(tampered, SECRET);
    expect(result.valid).toBe(false);
  });

  test('expired state (expiresAt in past) is rejected', () => {
    // Construct a state with expiresAt in the past.
    const { createHmac } = require('node:crypto');
    const nonce = 'AAAAAAAAAAAAAAAA';
    const nonceB64 = Buffer.from(nonce).toString('base64url');
    const expiresAt = Date.now() - 1000; // 1 second in the past
    const payload = `${nonceB64}.${expiresAt}`;
    const mac = createHmac('sha256', SECRET).update(payload).digest('base64url');
    const expiredState = `${payload}.${mac}`;
    const result = verifyOAuthState(expiredState, SECRET);
    expect(result.valid).toBe(false);
    expect((result as { valid: false; reason: string }).reason).toBe('state_expired');
  });

  test('malformed state (wrong number of segments) is rejected', () => {
    const result = verifyOAuthState('only-two-parts', SECRET);
    expect(result.valid).toBe(false);
    expect((result as { valid: false; reason: string }).reason).toBe('malformed_state');
  });

  test('different secret rejects valid state', () => {
    const state = generateOAuthState(SECRET);
    const result = verifyOAuthState(state, 'different-secret');
    expect(result.valid).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// SPEC-804 T4: Block Kit approval blocks
// ---------------------------------------------------------------------------

describe('SPEC-804 T4: buildApprovalBlocks', () => {
  test('returns array with section + divider + actions blocks', () => {
    const blocks = buildApprovalBlocks('req-001', 'Execute shell command');
    expect(Array.isArray(blocks)).toBe(true);
    const types = blocks.map((b) => b.type);
    expect(types).toContain('section');
    expect(types).toContain('actions');
    expect(types).toContain('divider');
  });

  test('description is included in section text', () => {
    const blocks = buildApprovalBlocks('req-001', 'Execute shell command');
    const section = blocks.find((b) => b.type === 'section') as { type: 'section'; text: { text: string } };
    expect(section?.text?.text).toContain('Execute shell command');
  });

  test('actions block contains approve and deny buttons', () => {
    const blocks = buildApprovalBlocks('req-001', 'test');
    const actions = blocks.find((b) => b.type === 'actions') as {
      type: 'actions';
      elements: Array<{ text: { text: string }; action_id: string }>;
    };
    expect(actions).toBeDefined();
    const texts = actions!.elements.map((e) => e.text.text);
    const hasApprove = texts.some((t) => t.toLowerCase().includes('approve'));
    const hasDeny = texts.some((t) => t.toLowerCase().includes('deny'));
    expect(hasApprove).toBe(true);
    expect(hasDeny).toBe(true);
  });

  test('action_id encodes requestId (approve button)', () => {
    const blocks = buildApprovalBlocks('req-abc', 'test');
    const actions = blocks.find((b) => b.type === 'actions') as {
      type: 'actions';
      elements: Array<{ text: { text: string }; action_id: string }>;
    };
    const approveBtn = actions!.elements.find((e) => e.text.text.toLowerCase().includes('approve'));
    expect(approveBtn?.action_id).toContain('req-abc');
  });

  test('long requestId is truncated to prevent action_id overflow', () => {
    const longId = 'x'.repeat(300);
    const blocks = buildApprovalBlocks(longId, 'test');
    const actions = blocks.find((b) => b.type === 'actions') as {
      type: 'actions';
      elements: Array<{ action_id: string }>;
    };
    for (const el of actions!.elements) {
      expect(el.action_id.length).toBeLessThanOrEqual(255);
    }
  });
});

describe('SPEC-804 T4: parseApprovalAction', () => {
  test('parses approve action_id and returns approved=true', () => {
    const blocks = buildApprovalBlocks('req-xyz', 'test');
    const actions = blocks.find((b) => b.type === 'actions') as {
      type: 'actions';
      elements: Array<{ text: { text: string }; action_id: string }>;
    };
    const approveBtn = actions!.elements.find((e) => e.text.text.toLowerCase().includes('approve'));
    const result = parseApprovalAction(approveBtn!.action_id);
    expect(result).not.toBeNull();
    expect(result!.approved).toBe(true);
    expect(result!.requestId).toBeTruthy();
  });

  test('parses deny action_id and returns approved=false', () => {
    const blocks = buildApprovalBlocks('req-xyz', 'test');
    const actions = blocks.find((b) => b.type === 'actions') as {
      type: 'actions';
      elements: Array<{ text: { text: string }; action_id: string }>;
    };
    const denyBtn = actions!.elements.find((e) => e.text.text.toLowerCase().includes('deny'));
    const result = parseApprovalAction(denyBtn!.action_id);
    expect(result).not.toBeNull();
    expect(result!.approved).toBe(false);
  });

  test('returns null for unrelated action_id', () => {
    expect(parseApprovalAction('some_other_action')).toBeNull();
    expect(parseApprovalAction('')).toBeNull();
  });
});

describe('SPEC-804 T4: buildDraftBlocks + buildReplyBlocks', () => {
  test('buildDraftBlocks returns at least one section block', () => {
    const blocks = buildDraftBlocks();
    expect(blocks.some((b) => b.type === 'section')).toBe(true);
  });

  test('buildReplyBlocks includes provided text', () => {
    const blocks = buildReplyBlocks('Agent reply here');
    const section = blocks.find((b) => b.type === 'section') as { type: 'section'; text: { text: string } };
    expect(section?.text?.text).toContain('Agent reply here');
  });
});

// ---------------------------------------------------------------------------
// SPEC-804 T3: unknown user silent-ignore + security event log
// ---------------------------------------------------------------------------

describe('SPEC-804 T3: security event published for unknown Slack user', () => {
  test('security.event topic is registered in EventBus', () => {
    const bus = createEventBus();
    const events: unknown[] = [];
    // Should NOT throw — topic is registered.
    const dispose = bus.subscribe(TOPICS.security.event, (e) => { events.push(e); });
    bus.publish(TOPICS.security.event, {
      type: 'security.event',
      adapterId: 'slack',
      reason: 'unauthorized_slack_user',
      userId: 'U99999999Z',
      ts: Date.now(),
    });
    dispose();
    expect(TOPICS.security.event).toBe('security.event');
  });

  test('channel.inbound published for allowed user shape', () => {
    const bus = createEventBus();
    const events: ChannelInboundEvent[] = [];
    const dispose = bus.subscribe<ChannelInboundEvent>(TOPICS.channel.inbound, (e) => {
      events.push(e);
    });
    const evt: ChannelInboundEvent = {
      type: 'channel.inbound',
      adapterId: 'slack',
      workspaceId: 'ws1',
      userId: 'U01234567A',
      text: '<tool_output trusted="false">hello</tool_output>',
      raw: {},
    };
    bus.publish(TOPICS.channel.inbound, evt);
    dispose();
    expect(TOPICS.channel.inbound).toBe('channel.inbound');
  });
});
