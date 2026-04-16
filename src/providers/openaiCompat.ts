// OpenAI-compatible adapter — serves OpenAI, Groq, DeepSeek, Ollama via baseURL (SPEC-203).
// Strips thinking blocks (META-004 §2.4). Splits tool_result into role:'tool' messages.
import OpenAI, { APIError } from 'openai';
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

// --------------------------------------------------------------------- endpoints

export interface EndpointConfig {
  id: string;
  baseUrl: string;
  capabilities: ProviderCapabilities;
  apiKeyEnv: string;
}

export type EndpointName = 'openai' | 'groq' | 'deepseek' | 'ollama' | 'gemini';

const base = (over: Partial<ProviderCapabilities>): ProviderCapabilities => ({
  nativeTools: true,
  promptCaching: 'none',
  vision: 'none',
  extendedThinking: false,
  maxContextTokens: 128_000,
  supportsStreamingTools: true,
  supportsParallelTools: true,
  ...over,
});

export const ENDPOINTS: Record<EndpointName, EndpointConfig> = {
  openai: {
    id: 'openai-compat:openai',
    baseUrl: 'https://api.openai.com/v1',
    capabilities: base({ promptCaching: 'implicit', vision: 'both' }),
    apiKeyEnv: 'OPENAI_API_KEY',
  },
  groq: {
    id: 'openai-compat:groq',
    baseUrl: 'https://api.groq.com/openai/v1',
    capabilities: base({ promptCaching: 'none' }),
    apiKeyEnv: 'GROQ_API_KEY',
  },
  deepseek: {
    id: 'openai-compat:deepseek',
    baseUrl: 'https://api.deepseek.com/v1',
    capabilities: base({ promptCaching: 'implicit' }),
    apiKeyEnv: 'DEEPSEEK_API_KEY',
  },
  ollama: {
    id: 'openai-compat:ollama',
    baseUrl: 'http://localhost:11434/v1',
    capabilities: base({ promptCaching: 'none', maxContextTokens: 32_000 }),
    apiKeyEnv: 'OLLAMA_API_KEY',
  },
  gemini: {
    id: 'openai-compat:gemini',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai/',
    capabilities: base({ promptCaching: 'none', vision: 'both', maxContextTokens: 1_000_000 }),
    apiKeyEnv: 'GEMINI_API_KEY',
  },
};

export function getEndpoint(name: EndpointName): EndpointConfig {
  return ENDPOINTS[name];
}

export function getEndpointDynamic(name: string): EndpointConfig {
  if (name in ENDPOINTS) return ENDPOINTS[name as EndpointName];
  throw new NimbusError(ErrorCode.U_MISSING_CONFIG, {
    reason: 'unknown openai-compat endpoint',
    name,
    known: Object.keys(ENDPOINTS),
  });
}

// --------------------------------------------------------------------- message mapping

interface StripStats {
  stripped: number;
}

export function toOpenAIMessages(
  msgs: CanonicalMessage[],
  stats: StripStats = { stripped: 0 },
): OpenAI.Chat.ChatCompletionMessageParam[] {
  const out: OpenAI.Chat.ChatCompletionMessageParam[] = [];
  for (const m of msgs) {
    if (m.role === 'system') {
      out.push({ role: 'system', content: extractPlainText(m.content, stats) });
      continue;
    }
    if (typeof m.content === 'string') {
      out.push({ role: m.role, content: m.content });
      continue;
    }

    const toolResults = m.content.filter(
      (b): b is Extract<CanonicalBlock, { type: 'tool_result' }> =>
        b.type === 'tool_result',
    );
    const nonToolResult = m.content.filter((b) => b.type !== 'tool_result');

    if (m.role === 'assistant') {
      const assistantMsg = buildAssistantMessage(nonToolResult, stats);
      if (assistantMsg) out.push(assistantMsg);
    } else {
      const userContent = buildUserContent(nonToolResult, stats);
      if (userContent !== null) out.push({ role: 'user', content: userContent });
    }

    for (const tr of toolResults) {
      out.push({
        role: 'tool',
        tool_call_id: tr.toolUseId,
        content: typeof tr.content === 'string'
          ? tr.content
          : extractPlainText(tr.content, stats),
      });
    }
  }
  return out;
}

function buildAssistantMessage(
  blocks: CanonicalBlock[],
  stats: StripStats,
): OpenAI.Chat.ChatCompletionAssistantMessageParam | null {
  let text = '';
  const toolCalls: OpenAI.Chat.ChatCompletionMessageToolCall[] = [];
  for (const b of blocks) {
    if (b.type === 'text') text += b.text;
    else if (b.type === 'thinking') stats.stripped++;
    else if (b.type === 'tool_use') {
      toolCalls.push({
        id: b.id,
        type: 'function',
        function: {
          name: b.name,
          arguments: JSON.stringify(b.input ?? {}),
        },
      });
    }
  }
  if (!text && toolCalls.length === 0) return null;
  const msg: OpenAI.Chat.ChatCompletionAssistantMessageParam = {
    role: 'assistant',
    content: text || null,
  };
  if (toolCalls.length > 0) msg.tool_calls = toolCalls;
  return msg;
}

function buildUserContent(
  blocks: CanonicalBlock[],
  stats: StripStats,
):
  | string
  | Array<OpenAI.Chat.ChatCompletionContentPart>
  | null {
  const parts: OpenAI.Chat.ChatCompletionContentPart[] = [];
  let hasImage = false;
  for (const b of blocks) {
    if (b.type === 'text') parts.push({ type: 'text', text: b.text });
    else if (b.type === 'image') {
      hasImage = true;
      const url =
        b.source.kind === 'base64'
          ? `data:${b.source.mimeType};base64,${b.source.data}`
          : b.source.data;
      parts.push({ type: 'image_url', image_url: { url } });
    } else if (b.type === 'thinking') {
      stats.stripped++;
    }
  }
  if (parts.length === 0) return null;
  if (!hasImage && parts.length === 1 && parts[0]?.type === 'text') {
    return parts[0].text;
  }
  return parts;
}

function extractPlainText(
  content: string | CanonicalBlock[],
  stats: StripStats,
): string {
  if (typeof content === 'string') return content;
  let out = '';
  for (const b of content) {
    if (b.type === 'text') out += b.text;
    else if (b.type === 'thinking') stats.stripped++;
  }
  return out;
}

export function toOpenAITools(
  tools: ToolDefinition[],
): OpenAI.Chat.ChatCompletionTool[] {
  return tools.map((t) => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description,
      parameters: t.inputSchema as Record<string, unknown>,
    },
  }));
}

// --------------------------------------------------------------------- reasoning models

// OpenAI reasoning-class models (o1/o3/o4-series, gpt-5+) require `max_completion_tokens`
// and reject `max_tokens` + `temperature`. Detection is name-based — OpenAI API currently
// exposes no machine-readable capability flag. Safe match: anchored prefix only, so
// arbitrary baseUrl models (e.g. `groq/o1-mini-local`) still match only when using the
// bare canonical name. DeepSeek/Groq/Ollama don't ship reasoning models under OpenAI
// names, so the regex stays specific rather than broad.
const REASONING_MODEL_RE = /^(o[1-9](?:-|$)|gpt-[5-9](?:[.-]|$))/i;

export function isReasoningModel(model: string): boolean {
  return REASONING_MODEL_RE.test(model);
}

// --------------------------------------------------------------------- streaming

interface ToolCallAcc {
  id: string;
  name: string;
  args: string;
  started: boolean;
}

interface StreamCtx {
  client: OpenAI;
  req: CanonicalRequest;
  signal: AbortSignal;
}

export async function* streamOpenAICompat(
  ctx: StreamCtx,
): AsyncIterable<CanonicalChunk> {
  const stats: StripStats = { stripped: 0 };
  const messages = toOpenAIMessages(
    [
      ...(ctx.req.system ? [{ role: 'system' as const, content: ctx.req.system }] : []),
      ...ctx.req.messages,
    ],
    stats,
  );
  const params: OpenAI.Chat.ChatCompletionCreateParamsStreaming = {
    model: ctx.req.model,
    stream: true,
    stream_options: { include_usage: true },
    messages,
  };
  if (ctx.req.maxTokens !== undefined) {
    if (isReasoningModel(ctx.req.model)) {
      params.max_completion_tokens = ctx.req.maxTokens;
    } else {
      params.max_tokens = ctx.req.maxTokens;
    }
  }
  if (ctx.req.temperature !== undefined && !isReasoningModel(ctx.req.model)) {
    params.temperature = ctx.req.temperature;
  }
  if (ctx.req.tools && ctx.req.tools.length > 0) {
    params.tools = toOpenAITools(ctx.req.tools);
  }

  // SPEC-206 T4 — reasoning_effort pass-through (OpenAI o-series + gpt-5+).
  // Silently dropped for non-reasoning models via `applied === false`.
  if (ctx.req.reasoning?.applied && isReasoningModel(ctx.req.model)) {
    const effort = ctx.req.reasoning.effort;
    const mapped: 'low' | 'medium' | 'high' =
      effort === 'high' ? 'high' : effort === 'minimal' || effort === 'low' ? 'low' : 'medium';
    (params as unknown as Record<string, unknown>).reasoning_effort = mapped;
  }

  let stream: AsyncIterable<OpenAI.Chat.ChatCompletionChunk>;
  try {
    stream = await ctx.client.chat.completions.create(params, {
      signal: ctx.signal,
    });
  } catch (err) {
    throw classifyOpenAIError(err);
  }

  let messageStarted = false;
  let textIndex = -1;
  let textOpen = false;
  const toolCalls = new Map<number, ToolCallAcc>();
  const openToolIndices = new Map<number, number>();
  let nextIndex = 0;

  try {
    for await (const chunk of stream) {
      if (!messageStarted) {
        messageStarted = true;
        yield { type: 'message_start', id: chunk.id, model: chunk.model };
      }

      const choice = chunk.choices[0];
      if (choice) {
        const delta = choice.delta;

        if (delta.content) {
          if (!textOpen) {
            textIndex = nextIndex++;
            textOpen = true;
            yield {
              type: 'content_block_start',
              index: textIndex,
              block: { type: 'text', text: '' },
            };
          }
          yield {
            type: 'content_block_delta',
            index: textIndex,
            delta: { type: 'text', text: delta.content },
          };
        }

        if (delta.tool_calls) {
          for (const tc of delta.tool_calls) {
            let acc = toolCalls.get(tc.index);
            if (!acc) {
              acc = { id: tc.id ?? '', name: '', args: '', started: false };
              toolCalls.set(tc.index, acc);
            }
            if (tc.id) acc.id = tc.id;
            if (tc.function?.name) acc.name += tc.function.name;
            if (tc.function?.arguments) acc.args += tc.function.arguments;
            // Defer content_block_start until finish_reason — emit once with fully-parsed input.
          }
        }

        if (choice.finish_reason) {
          if (textOpen) {
            yield { type: 'content_block_stop', index: textIndex };
            textOpen = false;
          }
          for (const [tcIndex, acc] of toolCalls.entries()) {
            if (!acc.id || !acc.name) continue;
            const parsed = tryParseJSON(acc.args);
            if (parsed.error) {
              yield {
                type: 'error',
                code: ErrorCode.P_INVALID_REQUEST,
                message: `invalid tool_call arguments JSON: ${parsed.error}`,
              };
              continue;
            }
            const outIndex = nextIndex++;
            openToolIndices.set(tcIndex, outIndex);
            yield {
              type: 'content_block_start',
              index: outIndex,
              block: {
                type: 'tool_use',
                id: acc.id,
                name: acc.name,
                input: (parsed.value ?? {}) as Record<string, unknown>,
              },
            };
            yield { type: 'content_block_stop', index: outIndex };
          }
          openToolIndices.clear();
          yield {
            type: 'message_stop',
            finishReason: mapFinishReason(choice.finish_reason),
          };
        }
      }

      if (chunk.usage) {
        const promptDetails = (chunk.usage as unknown as {
          prompt_tokens_details?: { cached_tokens?: number };
        }).prompt_tokens_details;
        const cacheRead = promptDetails?.cached_tokens ?? 0;
        yield {
          type: 'usage',
          input: chunk.usage.prompt_tokens,
          output: chunk.usage.completion_tokens,
          cacheRead,
        };
      }
    }
  } catch (err) {
    if (ctx.signal.aborted) throw err;
    throw classifyOpenAIError(err);
  }
}

function tryParseJSON(
  s: string,
): { value: unknown; error?: string } {
  if (s.length === 0) return { value: {} };
  try {
    return { value: JSON.parse(s) };
  } catch (err) {
    return {
      value: null,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

function mapFinishReason(r: string): FinishReason {
  switch (r) {
    case 'tool_calls':
    case 'function_call':
      return 'tool_use';
    case 'length':
      return 'max_tokens';
    case 'content_filter':
      return 'stop_sequence';
    default:
      return 'end_turn';
  }
}

// --------------------------------------------------------------------- errors

export function classifyOpenAIError(err: unknown): NimbusError {
  if (err instanceof NimbusError) return err;
  if (err instanceof Error && err.name === 'AbortError') throw err;

  if (err instanceof APIError) {
    const status = err.status;
    const msg = (err.message || '').toLowerCase();
    if (status === 401 || status === 403) {
      return new NimbusError(ErrorCode.P_AUTH, { status });
    }
    if (status === 429) {
      return new NimbusError(ErrorCode.P_429, { status });
    }
    if (status === 404 || msg.includes('model') && msg.includes('not found')) {
      return new NimbusError(ErrorCode.P_MODEL_NOT_FOUND, { status });
    }
    if (status === 400 && (msg.includes('context') || msg.includes('maximum context'))) {
      return new NimbusError(ErrorCode.P_CONTEXT_OVERFLOW, { status });
    }
    if (status === 400) {
      return new NimbusError(ErrorCode.P_INVALID_REQUEST, { status });
    }
    if (status !== undefined && status >= 500) {
      return new NimbusError(ErrorCode.P_5XX, { status });
    }
    if (status === undefined) {
      return new NimbusError(ErrorCode.P_NETWORK, { reason: err.message });
    }
    return new NimbusError(ErrorCode.P_INVALID_REQUEST, { status });
  }

  if (err instanceof Error) {
    return new NimbusError(ErrorCode.P_NETWORK, { reason: err.message });
  }
  return new NimbusError(ErrorCode.P_NETWORK, { reason: String(err) });
}

// --------------------------------------------------------------------- provider factory

export interface OpenAICompatProviderOptions {
  endpoint: EndpointName | 'custom';
  baseUrl?: string;
  apiKey?: string;
  defaultModel: string;
  capabilities?: Partial<ProviderCapabilities>;
}

export function createOpenAICompatProvider(
  opts: OpenAICompatProviderOptions,
): Provider {
  let config: EndpointConfig;
  if (opts.endpoint === 'custom') {
    if (!opts.baseUrl) {
      throw new NimbusError(ErrorCode.U_MISSING_CONFIG, {
        reason: 'custom endpoint requires baseUrl',
      });
    }
    config = {
      id: 'openai-compat:custom',
      baseUrl: opts.baseUrl,
      capabilities: base(opts.capabilities ?? {}),
      apiKeyEnv: 'CUSTOM_API_KEY',
    };
  } else {
    config = ENDPOINTS[opts.endpoint];
  }

  const resolvedKey = opts.apiKey ?? process.env[config.apiKeyEnv];
  if (!resolvedKey && opts.endpoint !== 'ollama') {
    throw new NimbusError(ErrorCode.U_MISSING_CONFIG, {
      reason: 'provider_key_missing',
      provider: config.id,
      hint: 'run `nimbus key set <provider>` or set the provider env var',
    });
  }
  const apiKey = resolvedKey ?? 'ollama-no-auth';
  const client = new OpenAI({ apiKey, baseURL: config.baseUrl });

  return {
    id: config.id,
    capabilities: () => config.capabilities,
    stream: (req: CanonicalRequest, { signal }: StreamOpts) =>
      streamOpenAICompat({ client, req, signal }),
  };
}
