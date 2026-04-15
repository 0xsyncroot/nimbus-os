// index.ts — SPEC-902: key module barrel.

export {
  createKeyManager,
  keyringServiceName,
  maskKey,
  type KeyManager,
  type KeyListEntry,
  type KeySetOptions,
  type KeyTestResult,
  type KeyManagerDeps,
} from './manager.ts';
export { runKeyCli } from './cli.ts';
