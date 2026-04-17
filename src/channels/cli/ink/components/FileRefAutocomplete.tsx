// FileRefAutocomplete.tsx — SPEC-842 T3: fuzzy file-ref autocomplete.
// Triggered by '@' prefix. Glob scan with FILE_REF_SCAN_TIMEOUT_MS=200.
// SENSITIVE_PATTERNS deny-list — hidden from results AND submission rejected.
// .gitignore + .nimbusignore pre-filter. 200-result cap. ANSI-OSC stripped from previews.

import React, { useState, useEffect, useCallback, useRef } from 'react';
import { Box, Text, useInput } from 'ink';
import { join, relative, resolve } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { Glob } from 'bun';
import { ThemedText } from './ThemedText.tsx';
import { inspectPath } from '../../../../permissions/pathValidator.ts';
import { stripAnsiOsc } from './Markdown.tsx';
import { ErrorCode, NimbusError } from '../../../../observability/errors.ts';

// ── Constants ─────────────────────────────────────────────────────────────────

export const FILE_REF_SCAN_TIMEOUT_MS = 200;
const MAX_RESULTS = 200;
const DEBOUNCE_MS = 80;

// ── Props ─────────────────────────────────────────────────────────────────────

export interface FileRefAutocompleteProps {
  /** The partial path after '@', e.g. 'src/foo'. */
  prefix: string;
  /** Absolute path to workspace root for Glob scanning. */
  workspaceRoot: string;
  /** Called with the accepted relative path. */
  onAccept: (path: string) => void;
  /** Called when user presses Esc. */
  onDismiss: () => void;
}

// ── .nimbusignore / .gitignore reader ─────────────────────────────────────────

function readIgnorePatterns(workspaceRoot: string): string[] {
  const files = ['.gitignore', '.nimbusignore'];
  const patterns: string[] = [];
  for (const f of files) {
    const fp = join(workspaceRoot, f);
    if (existsSync(fp)) {
      try {
        const content = readFileSync(fp, 'utf8');
        for (const line of content.split('\n')) {
          const trimmed = line.trim();
          if (trimmed && !trimmed.startsWith('#')) {
            patterns.push(trimmed);
          }
        }
      } catch {
        // Silently ignore unreadable ignore files
      }
    }
  }
  return patterns;
}

// Simple gitignore-style match: supports prefix (dir/) and glob (*).
function matchesIgnore(relPath: string, patterns: string[]): boolean {
  for (const pat of patterns) {
    const normalized = pat.endsWith('/') ? pat.slice(0, -1) : pat;
    // Check if any path segment or prefix matches
    if (relPath === normalized) return true;
    if (relPath.startsWith(normalized + '/')) return true;
    // Simple wildcard: *.ext
    if (normalized.startsWith('*')) {
      const suffix = normalized.slice(1);
      if (relPath.endsWith(suffix)) return true;
    }
    // node_modules, dist, etc. at any level
    const parts = relPath.split('/');
    if (parts.includes(normalized)) return true;
  }
  return false;
}

// ── Sensitive path check ─────────────────────────────────────────────────────

function isSensitivePath(absPath: string): boolean {
  const result = inspectPath(absPath);
  return result.matched;
}

// ── Glob scanner ─────────────────────────────────────────────────────────────

async function scanFiles(
  workspaceRoot: string,
  prefix: string,
  signal: AbortSignal,
): Promise<string[]> {
  const ignorePatterns = readIgnorePatterns(workspaceRoot);
  const pattern = prefix ? `**/${prefix}*` : '**/*';

  const results: string[] = [];
  const glob = new Glob(pattern);

  try {
    for await (const file of glob.scan({ cwd: workspaceRoot, absolute: false })) {
      if (signal.aborted) break;
      if (results.length >= MAX_RESULTS) break;

      const absPath = resolve(workspaceRoot, file);
      const relPath = relative(workspaceRoot, absPath);

      // Apply ignore patterns
      if (matchesIgnore(relPath, ignorePatterns)) continue;

      // Apply SENSITIVE_PATTERNS deny-list — hidden from results
      if (isSensitivePath(absPath)) continue;

      // Strip ANSI/OSC from the path for safe display (META-009 T22)
      const safePath = stripAnsiOsc(relPath);
      results.push(safePath);
    }
  } catch {
    // Glob scan errors are non-fatal — return partial results
  }

  return results;
}

// ── Component ─────────────────────────────────────────────────────────────────

export function FileRefAutocomplete({
  prefix,
  workspaceRoot,
  onAccept,
  onDismiss,
}: FileRefAutocompleteProps): React.ReactElement {
  const [results, setResults] = useState<string[]>([]);
  const [cursorIndex, setCursorIndex] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    // Debounce scan
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      // Abort previous scan
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;

      // Timeout abort at FILE_REF_SCAN_TIMEOUT_MS
      const timeoutId = setTimeout(() => {
        controller.abort();
      }, FILE_REF_SCAN_TIMEOUT_MS);

      scanFiles(workspaceRoot, prefix, controller.signal)
        .then((files) => {
          clearTimeout(timeoutId);
          if (!controller.signal.aborted) {
            setResults(files);
            setCursorIndex(0);
          }
        })
        .catch(() => {
          clearTimeout(timeoutId);
        });
    }, DEBOUNCE_MS);

    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [prefix, workspaceRoot]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      abortRef.current?.abort();
    };
  }, []);

  const safeCursor = Math.min(cursorIndex, Math.max(0, results.length - 1));

  const acceptCurrent = useCallback(() => {
    const path = results[safeCursor];
    if (!path) return;

    // SECURITY: Re-check SENSITIVE_PATTERNS on submission (deny even if somehow in results)
    const absPath = resolve(workspaceRoot, path);
    if (isSensitivePath(absPath)) {
      setError(`Path blocked: ${path} matches sensitive pattern (P_OPERATION_DENIED)`);
      throw new NimbusError(ErrorCode.P_OPERATION_DENIED, {
        reason: 'sensitive_file_ref',
        path,
        hint: 'This file matches a sensitive pattern and cannot be referenced.',
      });
    }

    setError(null);
    onAccept(path);
  }, [results, safeCursor, workspaceRoot, onAccept]);

  useInput((_input, key) => {
    if (key.upArrow) {
      setCursorIndex((prev) => (prev > 0 ? prev - 1 : Math.max(0, results.length - 1)));
      return;
    }
    if (key.downArrow) {
      setCursorIndex((prev) =>
        results.length > 0 ? (prev < results.length - 1 ? prev + 1 : 0) : 0,
      );
      return;
    }
    if (key.tab && !key.shift) {
      acceptCurrent();
      return;
    }
    if (key.return) {
      acceptCurrent();
      return;
    }
    if (key.escape) {
      onDismiss();
      return;
    }
  });

  if (error) {
    return (
      <Box borderStyle="round" borderColor="red" paddingX={1}>
        <ThemedText token="error">{error}</ThemedText>
      </Box>
    );
  }

  if (results.length === 0) {
    return (
      <Box borderStyle="round" borderColor="gray" paddingX={1}>
        <Text dimColor>{prefix ? `No files matching "${prefix}"` : 'Scanning files…'}</Text>
      </Box>
    );
  }

  const MAX_VISIBLE = 8;
  const visible = results.slice(0, MAX_VISIBLE);

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="gray">
      {visible.map((file, idx) => {
        const isSelected = idx === safeCursor;
        return (
          <Box key={file} paddingX={1}>
            {isSelected ? (
              <Box>
                <ThemedText token="claude" bold>
                  {'> '}
                </ThemedText>
                <ThemedText token="claude">
                  {file}
                </ThemedText>
              </Box>
            ) : (
              <Box>
                <Text>{'  '}</Text>
                <ThemedText token="text">
                  {file}
                </ThemedText>
              </Box>
            )}
          </Box>
        );
      })}
      {results.length > MAX_VISIBLE && (
        <Box paddingX={1}>
          <Text dimColor>{`… ${results.length - MAX_VISIBLE} more (${results.length} total)`}</Text>
        </Box>
      )}
      <Box paddingX={1}>
        <Text dimColor>↑↓ navigate  Tab/Enter accept  Esc dismiss</Text>
      </Box>
    </Box>
  );
}

/**
 * Validate a @file path submission for sensitive patterns.
 * Throws NimbusError(P_OPERATION_DENIED) if blocked.
 * Call this before injecting a file reference into the prompt.
 */
export function validateFileRef(relPath: string, workspaceRoot: string): void {
  const absPath = resolve(workspaceRoot, relPath);
  if (isSensitivePath(absPath)) {
    throw new NimbusError(ErrorCode.P_OPERATION_DENIED, {
      reason: 'sensitive_file_ref',
      path: relPath,
      hint: 'This file matches a sensitive pattern and cannot be referenced.',
    });
  }
}
