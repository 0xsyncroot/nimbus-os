// mcpSecurity.ts — SPEC-306 §T8: Security hardening for MCP integration.
// Env sanitization, output cap, description cap.

/** Maximum allowed MCP tool description length (chars). */
export const MAX_TOOL_DESCRIPTION_CHARS = 2048;

/** Maximum allowed MCP tool output size (bytes). */
export const MAX_TOOL_OUTPUT_BYTES = 100 * 1024; // 100 KB

/** Patterns that identify secret env vars that must NOT be passed to subprocesses. */
const SECRET_PATTERNS: RegExp[] = [
  /_API_KEY$/i,
  /_TOKEN$/i,
  /_SECRET$/i,
  /^NIMBUS_VAULT_PASSPHRASE$/i,
  /^NIMBUS_BYPASS_CONFIRMED$/i,
];

/**
 * Strip secret env vars from a subprocess environment dict.
 * Returns a new object with secret keys removed.
 * Matches: *_API_KEY, *_TOKEN, *_SECRET, NIMBUS_VAULT_PASSPHRASE, NIMBUS_BYPASS_CONFIRMED.
 */
export function sanitizeSubprocessEnv(
  env: Record<string, string>,
): Record<string, string> {
  const clean: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (isSecretKey(k)) continue;
    clean[k] = v;
  }
  return clean;
}

function isSecretKey(key: string): boolean {
  for (const pattern of SECRET_PATTERNS) {
    if (pattern.test(key)) return true;
  }
  return false;
}

/**
 * Cap a tool description to MAX_TOOL_DESCRIPTION_CHARS.
 * Appends '…' when truncated.
 */
export function capToolDescription(description: string): string {
  if (description.length <= MAX_TOOL_DESCRIPTION_CHARS) return description;
  return description.slice(0, MAX_TOOL_DESCRIPTION_CHARS - 1) + '…';
}

/**
 * Cap tool output to MAX_TOOL_OUTPUT_BYTES.
 * If the string (utf-8 encoded) exceeds the limit, truncate and append a banner.
 */
export function capToolOutput(output: string): string {
  const encoded = new TextEncoder().encode(output);
  if (encoded.length <= MAX_TOOL_OUTPUT_BYTES) return output;
  // Truncate to byte limit then decode (may split a multi-byte char — use lossy approach)
  const truncated = new TextDecoder().decode(encoded.slice(0, MAX_TOOL_OUTPUT_BYTES));
  return truncated + `\n[MCP output truncated: exceeded ${MAX_TOOL_OUTPUT_BYTES} bytes]`;
}
