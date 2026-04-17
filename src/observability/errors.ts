// errors.ts — ErrorCode enum + NimbusError + classify per META-003

export enum ErrorCode {
  // Provider (P*) — transient + auth + API
  P_NETWORK = 'P_NETWORK',
  P_5XX = 'P_5XX',
  P_429 = 'P_429',
  P_AUTH = 'P_AUTH',
  P_INVALID_REQUEST = 'P_INVALID_REQUEST',
  P_CONTEXT_OVERFLOW = 'P_CONTEXT_OVERFLOW',
  P_MODEL_NOT_FOUND = 'P_MODEL_NOT_FOUND',

  // Tool (T*)
  T_TIMEOUT = 'T_TIMEOUT',
  T_CRASH = 'T_CRASH',
  T_VALIDATION = 'T_VALIDATION',
  T_PERMISSION = 'T_PERMISSION',
  T_NOT_FOUND = 'T_NOT_FOUND',
  T_NOT_IMPLEMENTED = 'T_NOT_IMPLEMENTED',
  T_MCP_UNAVAILABLE = 'T_MCP_UNAVAILABLE',
  T_ITERATION_CAP = 'T_ITERATION_CAP',
  T_RESOURCE_LIMIT = 'T_RESOURCE_LIMIT',

  // Session/Storage (S*)
  S_COMPACT_FAIL = 'S_COMPACT_FAIL',
  S_STORAGE_CORRUPT = 'S_STORAGE_CORRUPT',
  S_CONFIG_INVALID = 'S_CONFIG_INVALID',
  S_SOUL_PARSE = 'S_SOUL_PARSE',
  S_MEMORY_CONFLICT = 'S_MEMORY_CONFLICT',
  S_SCHEMA_MISMATCH = 'S_SCHEMA_MISMATCH',

  // Security (X*) — NEVER auto-heal
  X_BASH_BLOCKED = 'X_BASH_BLOCKED',
  X_PATH_BLOCKED = 'X_PATH_BLOCKED',
  X_NETWORK_BLOCKED = 'X_NETWORK_BLOCKED',
  X_INJECTION = 'X_INJECTION',
  X_CRED_ACCESS = 'X_CRED_ACCESS',
  X_AUDIT_BREAK = 'X_AUDIT_BREAK',

  // User (U*)
  U_BAD_COMMAND = 'U_BAD_COMMAND',
  U_MISSING_CONFIG = 'U_MISSING_CONFIG',
  U_UI_BUSY = 'U_UI_BUSY',            // UI occupied, cannot accept input
  U_UI_CANCELLED = 'U_UI_CANCELLED',  // User cancelled a pending UI operation

  // Platform / Permission UI extensions (P* additions — per META-012)
  P_KEYBIND_RESERVED = 'P_KEYBIND_RESERVED',  // Chord conflicts with reserved binding
  P_OPERATION_DENIED = 'P_OPERATION_DENIED',  // UI permission denied (alt-screen, modal, etc.)

  // System (Y*)
  Y_OOM = 'Y_OOM',
  Y_DISK_FULL = 'Y_DISK_FULL',
  Y_SUBAGENT_CRASH = 'Y_SUBAGENT_CRASH',
  Y_DAEMON_CRASH = 'Y_DAEMON_CRASH',
  Y_CIRCUIT_BREAKER_OPEN = 'Y_CIRCUIT_BREAKER_OPEN',
}

export class NimbusError extends Error {
  override readonly name = 'NimbusError';
  constructor(
    public readonly code: ErrorCode,
    public readonly context: Record<string, unknown> = {},
    public override readonly cause?: Error,
  ) {
    super(`${code}: ${JSON.stringify(context)}`);
  }

  get retryable(): boolean {
    return RETRYABLE_CODES.has(this.code);
  }

  get userFacing(): boolean {
    return USER_FACING_CODES.has(this.code);
  }

  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      context: this.context,
      cause: this.cause?.message,
    };
  }
}

const RETRYABLE_CODES = new Set<ErrorCode>([
  ErrorCode.P_NETWORK,
  ErrorCode.P_5XX,
  ErrorCode.P_429,
  ErrorCode.T_CRASH,
  ErrorCode.T_MCP_UNAVAILABLE,
  ErrorCode.S_COMPACT_FAIL,
  ErrorCode.S_STORAGE_CORRUPT,
  ErrorCode.Y_SUBAGENT_CRASH,
  ErrorCode.Y_DAEMON_CRASH,
]);

const USER_FACING_CODES = new Set<ErrorCode>([
  ErrorCode.P_AUTH,
  ErrorCode.T_PERMISSION,
  ErrorCode.U_BAD_COMMAND,
  ErrorCode.U_MISSING_CONFIG,
  ErrorCode.U_UI_BUSY,
  // U_UI_CANCELLED intentionally omitted — silent discard, no user message needed
  ErrorCode.P_KEYBIND_RESERVED,
  ErrorCode.P_OPERATION_DENIED,
  ErrorCode.S_CONFIG_INVALID,
  ErrorCode.X_BASH_BLOCKED,
  ErrorCode.X_PATH_BLOCKED,
  ErrorCode.X_NETWORK_BLOCKED,
  ErrorCode.X_INJECTION,
  ErrorCode.X_CRED_ACCESS,
  ErrorCode.X_AUDIT_BREAK,
  ErrorCode.Y_CIRCUIT_BREAKER_OPEN,
]);

/**
 * Normalize raw errors (from fetch/fs/child_process/...) into ErrorCode.
 * Used at system boundaries.
 */
export function classify(err: unknown): ErrorCode {
  if (err instanceof NimbusError) return err.code;

  if (err instanceof Error) {
    const msg = err.message.toLowerCase();
    const name = err.name;

    // Network errors
    if (
      name === 'AbortError' ||
      msg.includes('timeout') ||
      msg.includes('etimedout') ||
      msg.includes('econnrefused') ||
      msg.includes('econnreset') ||
      msg.includes('enotfound') ||
      msg.includes('network')
    ) {
      return ErrorCode.P_NETWORK;
    }

    // HTTP errors (when wrapped)
    if (msg.includes('429') || msg.includes('rate limit')) return ErrorCode.P_429;
    if (msg.includes('401') || msg.includes('403') || msg.includes('unauthorized')) return ErrorCode.P_AUTH;
    if (msg.match(/\b5\d{2}\b/)) return ErrorCode.P_5XX;
    if (msg.includes('400') || msg.includes('invalid request')) return ErrorCode.P_INVALID_REQUEST;
    if (msg.includes('context') && (msg.includes('exceed') || msg.includes('overflow'))) {
      return ErrorCode.P_CONTEXT_OVERFLOW;
    }

    // FS errors
    if (msg.includes('enoent') || msg.includes('no such file')) return ErrorCode.T_NOT_FOUND;
    if (msg.includes('eacces') || msg.includes('permission denied')) return ErrorCode.T_PERMISSION;
    if (msg.includes('enospc') || msg.includes('no space')) return ErrorCode.Y_DISK_FULL;

    // Zod
    if (name === 'ZodError') return ErrorCode.T_VALIDATION;
  }

  return ErrorCode.T_CRASH;
}

/**
 * Helper to create a NimbusError preserving the original cause.
 */
export function wrapError(err: unknown, code?: ErrorCode, context: Record<string, unknown> = {}): NimbusError {
  if (err instanceof NimbusError) return err;
  const resolved = code ?? classify(err);
  const cause = err instanceof Error ? err : new Error(String(err));
  return new NimbusError(resolved, context, cause);
}
