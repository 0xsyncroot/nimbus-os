// ChannelAdapter.ts — SPEC-802: uniform interface for all channel adapters.
// v0.1: CLI only. v0.3: HTTP/WS, Telegram, Slack.

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
  readonly id: string;
  readonly kind: 'cli' | 'http' | 'ws' | 'telegram' | 'slack';
  readonly nativeFormat: NativeFormat;
  readonly capabilities: ChannelCapabilities;
  start(): Promise<void>;
  stop(): Promise<void>;
  /** Send a text message to a specific workspace. */
  send(workspaceId: string, text: string): Promise<void>;
}
