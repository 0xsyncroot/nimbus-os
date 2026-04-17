// loopSanitize.test.ts — v0.3.16 end-to-end verification that an orphan
// tool_use in priorMessages never reaches the provider.
//
// Reproduces the exact failure user saw on v0.3.15:
//   session JSONL = [user, assistant(tool_use_A), <crash>]
//   next REPL turn: user types "tiếp tục thử lại"
//   priorMessages = orphan
//   runTurn must sanitize BEFORE calling provider → no 400.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runTurn } from '../../src/core/loop.ts';
import { createTurnAbort } from '../../src/core/cancellation.ts';
import { __resetGlobalBus } from '../../src/core/events.ts';
import { createWorkspaceDir } from '../../src/storage/workspaceStore.ts';
import { createSession } from '../../src/storage/sessionStore.ts';
import { workspacesDir } from '../../src/platform/paths.ts';
import type {
  CanonicalChunk,
  CanonicalMessage,
  CanonicalRequest,
  Provider,
  ProviderCapabilities,
  StreamOpts,
} from '../../src/ir/types.ts';
import type { TurnContext } from '../../src/core/turn.ts';

const OVERRIDE = join(tmpdir(), `nimbus-loop-sanitize-${Date.now()}-${Math.random().toString(36).slice(2)}`);

beforeAll(async () => {
  process.env['NIMBUS_HOME'] = OVERRIDE;
  await mkdir(OVERRIDE, { recursive: true });
});
afterAll(async () => {
  delete process.env['NIMBUS_HOME'];
  await rm(OVERRIDE, { recursive: true, force: true });
});
afterEach(async () => {
  await rm(workspacesDir(), { recursive: true, force: true }).catch(() => undefined);
});
beforeEach(() => {
  __resetGlobalBus();
});

function makeCapturingProvider(chunks: CanonicalChunk[]): {
  provider: Provider;
  captured: CanonicalRequest[];
} {
  const captured: CanonicalRequest[] = [];
  const provider: Provider = {
    id: 'mock-capture',
    capabilities(): ProviderCapabilities {
      return {
        nativeTools: true,
        promptCaching: 'none',
        vision: 'none',
        extendedThinking: false,
        maxContextTokens: 8000,
        supportsStreamingTools: true,
        supportsParallelTools: true,
      };
    },
    stream(req: CanonicalRequest, _opts: StreamOpts): AsyncIterable<CanonicalChunk> {
      captured.push({
        ...req,
        messages: req.messages.map((m) => ({
          role: m.role,
          content: typeof m.content === 'string' ? m.content : [...m.content],
        })),
      });
      return (async function* () {
        for (const c of chunks) yield c;
      })();
    },
  };
  return { provider, captured };
}

async function makeCtx(provider: Provider): Promise<{ ctx: TurnContext }> {
  const { meta } = await createWorkspaceDir({ name: 'sanitize-test' });
  const sess = await createSession(meta.id);
  const abort = createTurnAbort();
  return {
    ctx: {
      wsId: meta.id,
      sessionId: sess.id,
      channel: 'cli',
      mode: 'default',
      abort,
      provider,
      model: 'mock-1',
    },
  };
}

describe('v0.3.16 orphan tool_use regression — runTurn sanitizes before provider call', () => {
  test('replay of [user, assistant(tool_use) <crash>] synthesizes tool_result stub', async () => {
    const { provider, captured } = makeCapturingProvider([
      { type: 'content_block_start', index: 0, block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text', text: 'ok' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'usage', input: 5, output: 2 },
      { type: 'message_stop', finishReason: 'end_turn' },
    ]);
    const { ctx } = await makeCtx(provider);

    const priorMessages: CanonicalMessage[] = [
      { role: 'user', content: [{ type: 'text', text: 'list files' }] },
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'toolu_ORPHAN', name: 'Ls', input: {} },
        ],
      },
    ];

    for await (const _out of runTurn({ ctx, userMessage: 'tiếp tục thử lại', priorMessages })) {
      // drain
    }

    expect(captured).toHaveLength(1);
    const req = captured[0]!;
    // Final messages array sent to provider should be:
    //   [user q1, assistant(tool_use), user(synthetic tool_result), user "tiếp tục thử lại"]
    expect(req.messages.length).toBe(4);
    const third = req.messages[2]!;
    expect(third.role).toBe('user');
    const blocks = third.content;
    expect(Array.isArray(blocks)).toBe(true);
    if (Array.isArray(blocks)) {
      expect(blocks[0]).toMatchObject({
        type: 'tool_result',
        toolUseId: 'toolu_ORPHAN',
        isError: true,
      });
    }
    const last = req.messages[3]!;
    expect(last.role).toBe('user');
    expect(Array.isArray(last.content) ? last.content[0] : null).toMatchObject({
      type: 'text',
      text: 'tiếp tục thử lại',
    });
  });

  test('fully-paired history passes through untouched', async () => {
    const { provider, captured } = makeCapturingProvider([
      { type: 'content_block_start', index: 0, block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text', text: 'done' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'usage', input: 5, output: 2 },
      { type: 'message_stop', finishReason: 'end_turn' },
    ]);
    const { ctx } = await makeCtx(provider);

    const priorMessages: CanonicalMessage[] = [
      { role: 'user', content: [{ type: 'text', text: 'read x' }] },
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'toolu_OK', name: 'Read', input: {} }],
      },
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            toolUseId: 'toolu_OK',
            content: 'file body',
            isError: false,
          },
        ],
      },
      { role: 'assistant', content: [{ type: 'text', text: 'read.' }] },
    ];

    for await (const _out of runTurn({ ctx, userMessage: 'follow up', priorMessages })) {
      // drain
    }

    const req = captured[0]!;
    // [prior4 messages] + [user "follow up"] = 5
    expect(req.messages.length).toBe(5);
    // Verify no synthetic stubs were injected by searching for the sentinel
    // phrase used by sanitizePriorMessages.
    for (const m of req.messages) {
      if (typeof m.content === 'string') continue;
      for (const b of m.content) {
        if (b.type === 'tool_result' && typeof b.content === 'string') {
          expect(b.content).not.toContain('tool call interrupted');
        }
      }
    }
  });
});
