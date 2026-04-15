// ChannelAdapter.ts — abstract interface shared by CLI, HTTP/WS, Telegram, etc.
// v0.1: CLI only. Others arrive v0.3+.

export interface ChannelAdapter {
  readonly kind: 'cli' | 'http' | 'ws' | 'telegram' | 'slack';
  start(): Promise<void>;
  stop(): Promise<void>;
}
