// Barrel re-export of the Provider interface + related IR types.
// Consumers (core/, registry) import from '@providers/Provider' for ergonomics.
export type {
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
