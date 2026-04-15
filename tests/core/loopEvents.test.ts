import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runTurn } from '../../src/core/loop.ts';
import { createTurnAbort } from '../../src/core/cancellation.ts';
import { getGlobalBus, __resetGlobalBus } from '../../src/core/events.ts';
import { TOPICS } from '../../src/core/eventTypes.ts';
import { createWorkspaceDir, workspacePathsFor } from '../../src/storage/workspaceStore.ts';
import { createSession } from '../../src/storage/sessionStore.ts';
import { workspacesDir } from '../../src/platform/paths.ts';
import type {
  CanonicalChunk,
  CanonicalRequest,
  Provider,
  ProviderCapabilities,
  StreamOpts,
} from '../../src/ir/types.ts';
import type { TurnContext } from '../../src/core/turn.ts';

const OVERRIDE = join(tmpdir(), `nimbus-loop-evt-${Date.now()}-${Math.random().toString(36).slice(2)}`);

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

function mockProvider(chunks: CanonicalChunk[]): Provider {
  return {
    id: 'mock',
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
    stream(_req: CanonicalRequest, _opts: StreamOpts): AsyncIterable<CanonicalChunk> {
      return (async function* () {
        for (const c of chunks) yield c;
      })();
    },
  };
}

async function makeCtx(): Promise<{ ctx: TurnContext; wsId: string; sessionId: string }> {
  const { meta } = await createWorkspaceDir({ name: 'evttest' });
  const sess = await createSession(meta.id);
  const abort = createTurnAbort();
  return {
    wsId: meta.id,
    sessionId: sess.id,
    ctx: {
      wsId: meta.id,
      sessionId: sess.id,
      channel: 'cli',
      mode: 'default',
      abort,
      provider: mockProvider([]),
      model: 'mock-1',
    },
  };
}

describe('Task #34: event bus wiring in runTurn', () => {
  test('publishes user_msg + assistant_msg + turn_complete', async () => {
    const { ctx, wsId, sessionId } = await makeCtx();
    const chunks: CanonicalChunk[] = [
      { type: 'content_block_start', index: 0, block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text', text: 'hello world' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'usage', input: 10, output: 5 },
      { type: 'message_stop', finishReason: 'end_turn' },
    ];
    ctx.provider = mockProvider(chunks);

    const bus = getGlobalBus();
    const events: Array<{ topic: string; e: unknown }> = [];
    const captured: string[] = [
      TOPICS.session.userMsg,
      TOPICS.session.assistantMsg,
      TOPICS.session.turnComplete,
      TOPICS.session.usage,
    ];
    const disposers = captured.map((t) =>
      bus.subscribe(t, (e) => { events.push({ topic: t, e }); }),
    );

    for await (const _out of runTurn({ ctx, userMessage: 'hi', generateSpec: false })) {
      // drain
    }

    // Allow microtasks to drain subscriber queues.
    await new Promise((r) => setTimeout(r, 10));

    for (const d of disposers) d();

    const topics = events.map((x) => x.topic);
    expect(topics).toContain(TOPICS.session.userMsg);
    expect(topics).toContain(TOPICS.session.assistantMsg);
    expect(topics).toContain(TOPICS.session.turnComplete);
    expect(topics).toContain(TOPICS.session.usage);

    // Verify events.jsonl contains the records.
    const paths = await workspacePathsFor(wsId);
    const eventsPath = join(paths.sessionsDir, sessionId, 'events.jsonl');
    const body = await readFile(eventsPath, 'utf8');
    expect(body).toContain('"user_msg"');
    expect(body).toContain('"assistant_msg"');
    expect(body).toContain('"turn_complete"');
    expect(body).toContain('"usage"');
  });

  test('publishes tool_invocation + tool_result when tools run', async () => {
    const { ctx, wsId, sessionId } = await makeCtx();
    // First stream yields a tool_use; second stream ends turn.
    let streamCall = 0;
    ctx.provider = {
      id: 'mock',
      capabilities: () => ({
        nativeTools: true, promptCaching: 'none', vision: 'none',
        extendedThinking: false, maxContextTokens: 8000,
        supportsStreamingTools: true, supportsParallelTools: true,
      }),
      stream: (_req: CanonicalRequest, _opts: StreamOpts) => (async function* () {
        streamCall++;
        if (streamCall === 1) {
          yield { type: 'content_block_start', index: 0, block: { type: 'tool_use', id: 'tu1', name: 'Echo', input: { msg: 'hi' } } } as CanonicalChunk;
          yield { type: 'content_block_stop', index: 0 };
          yield { type: 'message_stop', finishReason: 'tool_use' };
        } else {
          yield { type: 'content_block_start', index: 0, block: { type: 'text', text: '' } };
          yield { type: 'content_block_delta', index: 0, delta: { type: 'text', text: 'done' } };
          yield { type: 'content_block_stop', index: 0 };
          yield { type: 'message_stop', finishReason: 'end_turn' };
        }
      })(),
    };

    const tools = {
      listTools: () => [{ name: 'Echo', description: 'echo', inputSchema: { type: 'object' } }],
      effectOf: (_n: string) => 'read' as const,
      execute: async (inv: { toolUseId: string; name: string; input: unknown }) => ({
        toolUseId: inv.toolUseId,
        ok: true,
        content: 'hi',
        sideEffects: 'read' as const,
      }),
    };

    const bus = getGlobalBus();
    const events: Array<{ topic: string; e: unknown }> = [];
    const disposers = [TOPICS.session.toolUse, TOPICS.session.toolResult].map((t) =>
      bus.subscribe(t, (e) => { events.push({ topic: t, e }); }),
    );

    for await (const _out of runTurn({ ctx, userMessage: 'use tool', tools, generateSpec: false })) {
      // drain
    }
    await new Promise((r) => setTimeout(r, 10));
    for (const d of disposers) d();

    const topics = events.map((x) => x.topic);
    expect(topics).toContain(TOPICS.session.toolUse);
    expect(topics).toContain(TOPICS.session.toolResult);

    const paths = await workspacePathsFor(wsId);
    const body = await readFile(join(paths.sessionsDir, sessionId, 'events.jsonl'), 'utf8');
    expect(body).toContain('"tool_invocation"');
    expect(body).toContain('"tool_result"');
    expect(body).toContain('sha256:'); // inputDigest
  });
});
