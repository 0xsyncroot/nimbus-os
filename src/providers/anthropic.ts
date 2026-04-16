// Anthropic adapter — maps CanonicalRequest ↔ Anthropic Messages API (SPEC-202).
// Imports only from '@anthropic-ai/sdk', '../ir/*', '../observability/errors'.
import Anthropic, { APIError } from '@anthropic-ai/sdk';
import type {
  CanonicalBlock,
  CanonicalChunk,
  CanonicalMessage,
  CanonicalRequest,
  FinishReason,
  Provider,
  ProviderCapabilities,
  StreamOpts,
  ToolDefinition,
} from '../ir/types';
import { ErrorCode, NimbusError } from '../observability/errors';

const MAX_CACHE_BREAKPOINTS = 4;

// --------------------------------------------------------------------- capabilities

const EXTENDED_THINKING_MODELS = ['sonnet', 'opus'];

export function anthropicCapabilities(model: string): ProviderCapabilities {
  const lower = model.toLowerCase();
  const extendedThinking = EXTENDED_THINKING_MODELS.some((m) => lower.includes(m));
  return {
    nativeTools: true,
    promptCaching: 'explicit',
    vision: 'both',
    extendedThinking,
    maxContextTokens: 200_000,
    supportsStreamingTools: true,
    supportsParallelTools: true,
  };
}

// --------------------------------------------------------------------- request mapping

type CacheEphemeral = { type: 'ephemeral' };
const EPHEMERAL: CacheEphemeral = { type: 'ephemeral' };

interface ToAnthropicOptions {
  capsExplicitCache: boolean;
  onCacheOverflow?: (dropped: number) => void;
}

export function toAnthropicRequest(
  req: CanonicalRequest,
  opts: ToAnthropicOptions = { capsExplicitCache: true },
): Anthropic.MessageCreateParamsStreaming {
  const systemBlocks = req.system ?? [];
  const systemRefs: CacheableRef[] = systemBlocks
    .map((b, i): CacheableRef | null =>
      b.type === 'text' && b.cacheHint === 'ephemeral'
        ? { id: cacheId('system', i) }
        : null,
    )
    .filter((r): r is CacheableRef => r !== null);
  const withLimits = applyCacheBreakpointLimit(
    [...systemRefs, ...collectCacheableBlocks(req.messages)],
    opts.onCacheOverflow,
  );
  const allowedIds = withLimits.allowedIds;
  const attach = opts.capsExplicitCache
    ? (id: string) => allowedIds.has(id)
    : () => false;

  const params: Anthropic.MessageCreateParamsStreaming = {
    model: req.model,
    max_tokens: req.maxTokens ?? 4096,
    stream: true,
    messages: req.messages
      .filter((m) => m.role !== 'system')
      .map((m) => ({
        role: m.role === 'assistant' ? 'assistant' : 'user',
        content: mapContent(m.content, attach),
      })),
  };

  if (systemBlocks.length > 0) {
    params.system = systemBlocks.map((b, i) => {
      if (b.type !== 'text') throw sysErr(b.type);
      const tb: Anthropic.TextBlockParam = { type: 'text', text: b.text };
      if (b.cacheHint === 'ephemeral' && attach(cacheId('system', i))) {
        tb.cache_control = EPHEMERAL;
      }
      return tb;
    });
  }

  if (req.tools && req.tools.length > 0) {
    params.tools = req.tools.map((t) => toAnthropicTool(t));
  }
  if (req.temperature !== undefined) params.temperature = req.temperature;

  // SPEC-206 T4 — inject thinking when reasoning is applied.
  if (req.reasoning?.applied) {
    const budget = budgetFromEffort(req.reasoning.effort);
    (params as unknown as Record<string, unknown>).thinking = {
      type: 'enabled',
      budget_tokens: budget,
    };
  }

  return params;
}

function budgetFromEffort(e: 'minimal' | 'low' | 'medium' | 'high'): number {
  switch (e) {
    case 'minimal':
      return 1024;
    case 'low':
      return 2048;
    case 'high':
      return 8192;
    default:
      return 4096;
  }
}

function sysErr(type: string): NimbusError {
  return new NimbusError(ErrorCode.P_INVALID_REQUEST, {
    reason: 'system block must be text',
    got: type,
  });
}

function toAnthropicTool(t: ToolDefinition): Anthropic.Tool {
  return {
    name: t.name,
    description: t.description,
    input_schema: t.inputSchema as Anthropic.Tool.InputSchema,
  };
}

function mapContent(
  content: string | CanonicalBlock[],
  attach: (id: string) => boolean,
): string | Anthropic.ContentBlockParam[] {
  if (typeof content === 'string') return content;
  return content.map((b, i) => mapBlock(b, i, attach));
}

function mapBlock(
  b: CanonicalBlock,
  i: number,
  attach: (id: string) => boolean,
): Anthropic.ContentBlockParam {
  switch (b.type) {
    case 'text': {
      const out: Anthropic.TextBlockParam = { type: 'text', text: b.text };
      if (b.cacheHint === 'ephemeral' && attach(cacheId('msg', i))) {
        out.cache_control = EPHEMERAL;
      }
      return out;
    }
    case 'image': {
      const source: Anthropic.ImageBlockParam['source'] =
        b.source.kind === 'base64'
          ? {
              type: 'base64',
              media_type: b.source.mimeType as Anthropic.Base64ImageSource['media_type'],
              data: b.source.data,
            }
          : { type: 'url', url: b.source.data };
      return { type: 'image', source };
    }
    case 'tool_use':
      return {
        type: 'tool_use',
        id: b.id,
        name: b.name,
        input: b.input as Record<string, unknown>,
      };
    case 'tool_result':
      return {
        type: 'tool_result',
        tool_use_id: b.toolUseId,
        content: mapToolResultContent(b.content),
        is_error: b.isError,
      };
    case 'thinking':
      return { type: 'thinking', thinking: b.text, signature: b.signature ?? '' };
  }
}

function mapToolResultContent(
  content: string | CanonicalBlock[],
): Anthropic.ToolResultBlockParam['content'] {
  if (typeof content === 'string') return content;
  const out: Array<Anthropic.TextBlockParam | Anthropic.ImageBlockParam> = [];
  for (const b of content) {
    if (b.type === 'text') out.push({ type: 'text', text: b.text });
    else if (b.type === 'image') {
      const source: Anthropic.ImageBlockParam['source'] =
        b.source.kind === 'base64'
          ? {
              type: 'base64',
              media_type: b.source.mimeType as Anthropic.Base64ImageSource['media_type'],
              data: b.source.data,
            }
          : { type: 'url', url: b.source.data };
      out.push({ type: 'image', source });
    }
  }
  return out;
}

// Cache breakpoint accounting: up to 4 blocks with cache_control across request.
interface CacheableRef {
  id: string;
}
function cacheId(scope: 'system' | 'msg', i: number): string {
  return `${scope}:${i}`;
}
function collectCacheableBlocks(msgs: CanonicalMessage[]): CacheableRef[] {
  const refs: CacheableRef[] = [];
  msgs.forEach((m) => {
    if (typeof m.content === 'string') return;
    m.content.forEach((b, i) => {
      if (b.type === 'text' && b.cacheHint === 'ephemeral') {
        refs.push({ id: cacheId('msg', i) });
      }
    });
  });
  return refs;
}
function applyCacheBreakpointLimit(
  refs: CacheableRef[],
  onOverflow: ((dropped: number) => void) | undefined,
): { allowedIds: Set<string> } {
  if (refs.length <= MAX_CACHE_BREAKPOINTS) {
    return { allowedIds: new Set(refs.map((r) => r.id)) };
  }
  const keep = refs.slice(-MAX_CACHE_BREAKPOINTS);
  if (onOverflow) onOverflow(refs.length - MAX_CACHE_BREAKPOINTS);
  return { allowedIds: new Set(keep.map((r) => r.id)) };
}

// --------------------------------------------------------------------- stream mapping

interface StreamCtx {
  client: Anthropic;
  req: CanonicalRequest;
  signal: AbortSignal;
}

export async function* streamAnthropic(
  ctx: StreamCtx,
): AsyncIterable<CanonicalChunk> {
  const params = toAnthropicRequest(ctx.req);
  let stream: AsyncIterable<Anthropic.RawMessageStreamEvent>;
  try {
    stream = ctx.client.messages.stream(params, { signal: ctx.signal });
  } catch (err) {
    throw classifyAnthropicError(err);
  }
  const inputJsonAcc = new Map<number, string>();
  let inputTokens = 0;
  let cacheRead = 0;
  let cacheWrite = 0;
  try {
    for await (const ev of stream) {
      const chunk = mapEvent(ev, inputJsonAcc);
      if (chunk) {
        if (chunk.type === 'message_start') {
          const msg = (ev as Anthropic.RawMessageStartEvent).message;
          inputTokens = msg.usage.input_tokens;
          cacheRead = msg.usage.cache_read_input_tokens ?? 0;
          cacheWrite = msg.usage.cache_creation_input_tokens ?? 0;
        }
        yield chunk;
      }
      if (ev.type === 'message_delta' && ev.usage) {
        const usage: CanonicalChunk = {
          type: 'usage',
          input: inputTokens,
          output: ev.usage.output_tokens,
          cacheRead,
          cacheWrite,
        };
        yield usage;
      }
    }
  } catch (err) {
    if (ctx.signal.aborted) throw err;
    throw classifyAnthropicError(err);
  }
}

function mapEvent(
  ev: Anthropic.RawMessageStreamEvent,
  jsonAcc: Map<number, string>,
): CanonicalChunk | null {
  switch (ev.type) {
    case 'message_start':
      return { type: 'message_start', id: ev.message.id, model: ev.message.model };
    case 'content_block_start': {
      const block = mapStartBlock(ev.content_block);
      if (!block) return null;
      if (ev.content_block.type === 'tool_use') jsonAcc.set(ev.index, '');
      return { type: 'content_block_start', index: ev.index, block };
    }
    case 'content_block_delta': {
      const delta = mapDelta(ev.delta, ev.index, jsonAcc);
      if (!delta) return null;
      return { type: 'content_block_delta', index: ev.index, delta };
    }
    case 'content_block_stop':
      jsonAcc.delete(ev.index);
      return { type: 'content_block_stop', index: ev.index };
    case 'message_delta':
      if (ev.delta.stop_reason) {
        return {
          type: 'message_stop',
          finishReason: mapFinishReason(ev.delta.stop_reason),
        };
      }
      return null;
    case 'message_stop':
      return null;
  }
}

function mapStartBlock(
  cb: Anthropic.RawContentBlockStartEvent['content_block'],
): CanonicalBlock | null {
  switch (cb.type) {
    case 'text':
      return { type: 'text', text: cb.text };
    case 'tool_use':
      return { type: 'tool_use', id: cb.id, name: cb.name, input: {} };
    case 'thinking':
      return { type: 'thinking', text: cb.thinking, signature: cb.signature };
    case 'redacted_thinking':
      return null;
  }
}

function mapDelta(
  d: Anthropic.RawContentBlockDelta,
  index: number,
  jsonAcc: Map<number, string>,
): Partial<CanonicalBlock> | null {
  switch (d.type) {
    case 'text_delta':
      return { type: 'text', text: d.text };
    case 'input_json_delta': {
      const cur = (jsonAcc.get(index) ?? '') + d.partial_json;
      jsonAcc.set(index, cur);
      let parsed: unknown = cur;
      try {
        parsed = JSON.parse(cur);
      } catch {
        // partial — keep raw string
      }
      return { type: 'tool_use', input: parsed };
    }
    case 'thinking_delta':
      return { type: 'thinking', text: d.thinking };
    case 'signature_delta':
      return { type: 'thinking', signature: d.signature, text: '' };
    case 'citations_delta':
      return null;
  }
}

function mapFinishReason(stop: string): FinishReason {
  switch (stop) {
    case 'tool_use':
      return 'tool_use';
    case 'max_tokens':
      return 'max_tokens';
    case 'stop_sequence':
      return 'stop_sequence';
    default:
      return 'end_turn';
  }
}

// --------------------------------------------------------------------- errors

export function classifyAnthropicError(err: unknown): NimbusError {
  if (err instanceof NimbusError) return err;
  if (err instanceof Error && err.name === 'AbortError') throw err;

  if (err instanceof APIError) {
    const bodyType = extractBodyErrorType(err);
    const status = err.status;
    if (status === 401 || status === 403) {
      return new NimbusError(ErrorCode.P_AUTH, { status, bodyType });
    }
    if (status === 429) {
      return new NimbusError(ErrorCode.P_429, { status, bodyType });
    }
    if (status === 404 && bodyType === 'not_found_error') {
      return new NimbusError(ErrorCode.P_MODEL_NOT_FOUND, { status, bodyType });
    }
    if (status === 400 && bodyType === 'context_length_exceeded') {
      return new NimbusError(ErrorCode.P_CONTEXT_OVERFLOW, { status, bodyType });
    }
    if (status === 400) {
      return new NimbusError(ErrorCode.P_INVALID_REQUEST, { status, bodyType });
    }
    if (status !== undefined && status >= 500) {
      return new NimbusError(ErrorCode.P_5XX, { status, bodyType });
    }
    if (bodyType === 'overloaded_error') {
      return new NimbusError(ErrorCode.P_5XX, { status, bodyType });
    }
    if (status === undefined) {
      return new NimbusError(ErrorCode.P_NETWORK, { reason: err.message });
    }
    return new NimbusError(ErrorCode.P_INVALID_REQUEST, { status, bodyType });
  }

  if (err instanceof Error) {
    return new NimbusError(ErrorCode.P_NETWORK, { reason: err.message });
  }
  return new NimbusError(ErrorCode.P_NETWORK, { reason: String(err) });
}

function extractBodyErrorType(err: APIError): string | undefined {
  const body = (err as unknown as { error?: { error?: { type?: string } } }).error;
  return body?.error?.type;
}

// --------------------------------------------------------------------- provider factory

export interface AnthropicProviderOptions {
  apiKey: string;
  baseUrl?: string;
  defaultModel: string;
}

export function createAnthropicProvider(opts: AnthropicProviderOptions): Provider {
  const client = new Anthropic({ apiKey: opts.apiKey, baseURL: opts.baseUrl });
  return {
    id: 'anthropic',
    capabilities: () => anthropicCapabilities(opts.defaultModel),
    stream: (req: CanonicalRequest, { signal }: StreamOpts) =>
      streamAnthropic({ client, req, signal }),
    countTokens: async (msgs) => countTokens(client, opts.defaultModel, msgs),
  };
}

async function countTokens(
  client: Anthropic,
  model: string,
  msgs: CanonicalMessage[],
): Promise<number> {
  try {
    const res = await client.messages.countTokens({
      model,
      messages: msgs
        .filter((m) => m.role !== 'system')
        .map((m) => ({
          role: m.role === 'assistant' ? 'assistant' : 'user',
          content: typeof m.content === 'string' ? m.content : m.content.map((b, i) =>
            mapBlock(b, i, () => false),
          ),
        })),
    });
    return res.input_tokens;
  } catch (err) {
    throw classifyAnthropicError(err);
  }
}
