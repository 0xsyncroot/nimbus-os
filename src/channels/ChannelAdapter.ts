// ChannelAdapter.ts — abstract interface shared by CLI, HTTP/WS, Telegram, etc.
// v0.1: CLI only. Others arrive v0.3+.

/** Format that the channel renders natively. Used by the renderer to decide
 *  how to format LLM output before handing it to the channel. */
export type NativeFormat = 'ansi' | 'telegram-html' | 'slack-mrkdwn' | 'markdown';

/** Per-channel capability declaration. Channels declare what they support so
 *  the core can adapt output accordingly. */
export interface ChannelCapabilities {
  /** How the channel renders text to the user. CLI → 'ansi'; bots → their format. */
  nativeFormat: NativeFormat;
}

export interface ChannelAdapter {
  readonly kind: 'cli' | 'http' | 'ws' | 'telegram' | 'slack';
  readonly capabilities: ChannelCapabilities;
  start(): Promise<void>;
  stop(): Promise<void>;
}
