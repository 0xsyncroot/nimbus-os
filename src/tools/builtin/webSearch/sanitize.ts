// webSearch/sanitize.ts — SPEC-305 T5: HTML strip + injection detector + URL validator.

import { NimbusError, ErrorCode } from '../../../observability/errors.ts';

// Patterns that indicate prompt injection attempts in search snippets.
const INJECTION_PATTERNS: ReadonlyArray<RegExp> = [
  /ignore\s+(previous|prior|all)\s+(instructions?|prompts?|context)/i,
  /disregard\s+(previous|prior|all)\s+(instructions?|prompts?|context|rules?)/i,
  /disregard\s+all\s+\w+/i,
  /forget\s+(previous|prior|all)\s+(instructions?|prompts?|context)/i,
  /you\s+are\s+now\s+(a|an|the)\s+/i,
  /act\s+as\s+(?:if\s+you\s+are|a|an|the)\s+/i,
  /system\s*prompt\s*:/i,
  /\[system\]/i,
  /<\|?system\|?>/i,
  /new\s+instructions?\s*:/i,
  /override\s+(previous|prior|all)\s+(instructions?|rules?)/i,
];

// Private IP ranges + loopback to guard against SSRF.
const PRIVATE_IP_PATTERNS: ReadonlyArray<RegExp> = [
  /^https?:\/\/localhost/i,
  /^https?:\/\/127\./,
  /^https?:\/\/0\.0\.0\.0/,
  /^https?:\/\/10\.\d+\.\d+\.\d+/,
  /^https?:\/\/172\.(1[6-9]|2\d|3[01])\.\d+\.\d+/,
  /^https?:\/\/192\.168\.\d+\.\d+/,
  /^https?:\/\/169\.254\.\d+\.\d+/, // link-local
  /^https?:\/\/\[::1\]/,             // IPv6 loopback
  /^https?:\/\/\[fc/i,               // IPv6 unique-local fc00::/7
  /^https?:\/\/\[fd/i,               // IPv6 unique-local fd00::/8
  /^https?:\/\/metadata\./i,         // cloud metadata
  /^https?:\/\/169\.254\.169\.254/,  // AWS/GCP/Azure IMDS
];

/**
 * Strip all HTML tags from a string, returning plain text.
 * Specifically targets <script> and <style> content removal (not just tag strips).
 */
export function stripHtml(input: string): string {
  // Remove <script>...</script> blocks including content.
  let out = input.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '');
  // Remove <style>...</style> blocks including content.
  out = out.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '');
  // Remove all remaining tags.
  out = out.replace(/<[^>]+>/g, '');
  // Decode common HTML entities.
  out = out
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ');
  return out.trim();
}

/**
 * Detect if a plain-text snippet contains prompt injection patterns.
 * Returns true if injection is detected.
 */
export function detectInjection(text: string): boolean {
  return INJECTION_PATTERNS.some((re) => re.test(text));
}

/**
 * Validate a URL: must be HTTPS, must not point to private/loopback IPs.
 * Throws NimbusError(X_NETWORK_BLOCKED) on violation.
 */
export function validateResultUrl(url: string): void {
  if (!url.startsWith('https://')) {
    throw new NimbusError(ErrorCode.X_NETWORK_BLOCKED, {
      reason: 'https_required',
      url,
    });
  }
  for (const pattern of PRIVATE_IP_PATTERNS) {
    if (pattern.test(url)) {
      throw new NimbusError(ErrorCode.X_NETWORK_BLOCKED, {
        reason: 'private_ip_blocked',
        url,
      });
    }
  }
}

/**
 * Sanitize a single search result snippet:
 * 1. Strip HTML tags.
 * 2. Detect injection — if found, replace with a safe placeholder.
 * Returns the safe snippet string.
 */
export function sanitizeSnippet(raw: string): { text: string; injectionDetected: boolean } {
  const stripped = stripHtml(raw);
  const injectionDetected = detectInjection(stripped);
  const text = injectionDetected
    ? '[snippet redacted: potential prompt injection detected]'
    : stripped;
  return { text, injectionDetected };
}
