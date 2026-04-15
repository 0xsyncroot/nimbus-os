// Canonical IR — provider-agnostic message/chunk/request types (META-004, SPEC-201).
// Pure TS: no Bun, no node:, no imports from core/tools/platform/storage/channels.

export interface ToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
}

export type CanonicalBlock =
  | { type: 'text'; text: string; cacheHint?: 'ephemeral' }
  | {
      type: 'image';
      source: { kind: 'base64' | 'url'; data: string; mimeType: string };
    }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | {
      type: 'tool_result';
      toolUseId: string;
      content: string | CanonicalBlock[];
      isError?: boolean;
    }
  | { type: 'thinking'; text: string; signature?: string };

export type CanonicalBlockType = CanonicalBlock['type'];

export interface CanonicalMessage {
  role: 'user' | 'assistant' | 'system';
  content: string | CanonicalBlock[];
}

export interface CanonicalRequest {
  messages: CanonicalMessage[];
  system?: CanonicalBlock[];
  tools?: ToolDefinition[];
  model: string;
  maxTokens?: number;
  temperature?: number;
  stream: true;
}

export type FinishReason =
  | 'end_turn'
  | 'tool_use'
  | 'max_tokens'
  | 'stop_sequence';

export type CanonicalChunk =
  | { type: 'message_start'; id: string; model: string }
  | { type: 'content_block_start'; index: number; block: CanonicalBlock }
  | {
      type: 'content_block_delta';
      index: number;
      delta: Partial<CanonicalBlock>;
    }
  | { type: 'content_block_stop'; index: number }
  | {
      type: 'usage';
      input: number;
      output: number;
      cacheRead?: number;
      cacheWrite?: number;
    }
  | { type: 'message_stop'; finishReason: FinishReason }
  | { type: 'error'; code: string; message: string };

export interface ProviderCapabilities {
  nativeTools: boolean;
  promptCaching: 'explicit' | 'implicit' | 'none';
  vision: 'base64' | 'url' | 'both' | 'none';
  extendedThinking: boolean;
  maxContextTokens: number;
  supportsStreamingTools: boolean;
  supportsParallelTools: boolean;
}

export interface StreamOpts {
  signal: AbortSignal;
}

export interface Provider {
  readonly id: string;
  capabilities(): ProviderCapabilities;
  stream(req: CanonicalRequest, opts: StreamOpts): AsyncIterable<CanonicalChunk>;
  countTokens?(msgs: CanonicalMessage[]): Promise<number>;
}

export function assertNever(x: never): never {
  throw new Error(`unexpected variant: ${JSON.stringify(x)}`);
}
