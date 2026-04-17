// errorFormat.ts — SPEC-901 v0.2.1: human-readable error messages for user-facing CLI output.
// SPEC-854: U_UI_BUSY, U_UI_CANCELLED, P_KEYBIND_RESERVED, P_OPERATION_DENIED routed through t().
// Raw JSON context is demoted to logger.debug (visible with --verbose / NIMBUS_LOG_LEVEL=debug).

import { ErrorCode, NimbusError } from './errors.ts';
import { t } from '../i18n/format.ts';

export interface FormattedError {
  summary: string;
  action: string;
}

/**
 * formatError — map NimbusError → 2-line human message.
 * Keep jargon out of summary/action; reserve details for debug log.
 */
export function formatError(err: NimbusError): FormattedError {
  switch (err.code) {
    case ErrorCode.U_MISSING_CONFIG: {
      const reason = err.context['reason'];
      if (reason === 'missing_passphrase') {
        return {
          summary: "Couldn't save your API key — no encryption passphrase available.",
          action: 'Fix: run `nimbus vault setup`, or set NIMBUS_VAULT_PASSPHRASE env var.',
        };
      }
      if (reason === 'no_active_workspace') {
        return {
          summary: 'No workspace found.',
          action: 'Fix: run `nimbus init` to create your first workspace.',
        };
      }
      return {
        summary: 'Required configuration is missing.',
        action: 'Check your workspace.json or run `nimbus init`.',
      };
    }

    case ErrorCode.P_AUTH:
      return {
        summary: "Your API key isn't valid.",
        action: 'Fix: run `nimbus key set <provider>` with a correct key.',
      };

    case ErrorCode.P_NETWORK:
      return {
        summary: 'Network request failed.',
        action: 'Check your internet connection, then try again.',
      };

    case ErrorCode.P_429:
      return {
        summary: 'Rate-limited by the provider.',
        action: 'Wait a moment, then retry. Consider a different model class.',
      };

    case ErrorCode.P_5XX:
      return {
        summary: 'The provider returned a server error.',
        action: 'This is likely temporary — try again in a minute.',
      };

    case ErrorCode.P_CONTEXT_OVERFLOW:
      return {
        summary: 'Your conversation is too long for the model.',
        action: 'Start a new session or use a model with a larger context window.',
      };

    case ErrorCode.P_MODEL_NOT_FOUND: {
      const model = err.context['model'] ?? 'unknown';
      return {
        summary: `Model "${model}" not found.`,
        action: 'Run `nimbus init` to pick a valid model, or set a different default.',
      };
    }

    case ErrorCode.T_PERMISSION:
      return {
        summary: 'Action blocked by permission rules.',
        action: 'Adjust your bash preset in TOOLS.md or use `nimbus key set` to update settings.',
      };

    case ErrorCode.T_NOT_FOUND: {
      const what = err.context['path'] ?? err.context['service'] ?? 'resource';
      return {
        summary: `Could not find: ${what}`,
        action: 'Verify the path exists and you have read permissions.',
      };
    }

    case ErrorCode.X_BASH_BLOCKED:
      return {
        summary: 'Shell command blocked by safety rules.',
        action: 'Review the command and adjust your bash preset if needed.',
      };

    case ErrorCode.X_PATH_BLOCKED:
      return {
        summary: 'File path blocked by safety rules.',
        action: 'The path is outside allowed directories. Check your workspace configuration.',
      };

    case ErrorCode.X_CRED_ACCESS: {
      // v0.3.7 URGENT FIX — new sub-reason `vault_locked` raised by
      // autoProvisionPassphrase when a vault exists but no usable passphrase
      // source is available. The hint comes with a concrete command.
      const reason = err.context['reason'];
      if (reason === 'vault_locked') {
        const hint = typeof err.context['hint'] === 'string' ? (err.context['hint'] as string) : null;
        return {
          summary: 'Stored keys cannot be unlocked with the current passphrase.',
          action: hint
            ? `Fix: ${hint}`
            : 'Fix: restore your previous NIMBUS_VAULT_PASSPHRASE, or run `nimbus vault reset` (old vault backed up).',
        };
      }
      return {
        summary: 'Credential access failed.',
        action: 'Your vault may be corrupted or the passphrase changed. Run `nimbus key set` again.',
      };
    }

    case ErrorCode.S_CONFIG_INVALID: {
      const reason = err.context['reason'];
      if (reason === 'unknown_secrets_backend') {
        return {
          summary: `Unknown secrets backend: "${err.context['value']}".`,
          action: 'Set NIMBUS_SECRETS_BACKEND to "file" or "auto".',
        };
      }
      return {
        summary: 'Configuration is invalid.',
        action: 'Run `nimbus init` to repair your workspace settings.',
      };
    }

    case ErrorCode.U_UI_BUSY:
      return {
        summary: t('error.ui_busy'),
        action: 'Wait for the current operation to complete.',
      };

    case ErrorCode.U_UI_CANCELLED:
      return {
        summary: t('error.ui_cancelled'),
        action: '',
      };

    case ErrorCode.P_KEYBIND_RESERVED: {
      const key = typeof err.context['key'] === 'string' ? (err.context['key'] as string) : 'that key';
      return {
        summary: t('error.keybind_reserved'),
        action: `The key "${key}" is reserved by nimbus. Choose a different binding.`,
      };
    }

    case ErrorCode.P_OPERATION_DENIED:
      return {
        summary: t('error.operation_denied'),
        action:
          typeof err.context['reason'] === 'string'
            ? (err.context['reason'] as string)
            : 'This operation is not permitted in the current context.',
      };

    case ErrorCode.U_BAD_COMMAND: {
      const reason = err.context['reason'];
      if (reason === 'workspace_exists') {
        return {
          summary: `Workspace "${err.context['name']}" already exists.`,
          action: 'Use `nimbus init --force` to overwrite, or choose a different name.',
        };
      }
      if (reason === 'location_traversal' || reason === 'location_not_absolute') {
        return {
          summary: 'Invalid workspace location.',
          action: 'Provide an absolute path without ".." segments.',
        };
      }
      return {
        summary: `Invalid command: ${err.context['hint'] ?? err.message}`,
        action: 'Run `nimbus --help` for usage information.',
      };
    }

    case ErrorCode.T_VALIDATION:
      return {
        summary: 'Input looks malformed — the tool received an unexpected format.',
        action: 'Check the argument spelling or run /doctor.',
      };

    case ErrorCode.T_TIMEOUT:
      return {
        summary: 'The operation timed out.',
        action: 'Try again, or increase the timeout if supported.',
      };

    case ErrorCode.T_CRASH:
      return {
        summary: 'A tool crashed unexpectedly.',
        action: 'Run with --verbose to see the stack trace.',
      };

    case ErrorCode.T_MCP_UNAVAILABLE:
      return {
        summary: 'An MCP tool is unavailable.',
        action: 'Check that the MCP server is running and configured correctly.',
      };

    case ErrorCode.T_ITERATION_CAP:
      return {
        summary: 'The agent hit its iteration limit.',
        action: 'Break the task into smaller steps or increase the iteration cap.',
      };

    case ErrorCode.T_RESOURCE_LIMIT:
      return {
        summary: 'A resource limit was exceeded.',
        action: 'Free up disk space or memory and try again.',
      };

    case ErrorCode.Y_OOM:
      return {
        summary: 'Out of memory.',
        action: 'Free up memory and restart. Run `nimbus doctor` to diagnose.',
      };

    case ErrorCode.Y_DISK_FULL:
      return {
        summary: 'Disk is full.',
        action: 'Free up disk space and retry. Run `nimbus doctor` to diagnose.',
      };

    case ErrorCode.Y_SUBAGENT_CRASH:
    case ErrorCode.Y_DAEMON_CRASH:
      return {
        summary: 'A background process crashed.',
        action: 'Run `nimbus doctor` to diagnose the environment.',
      };

    case ErrorCode.Y_CIRCUIT_BREAKER_OPEN:
      return {
        summary: 'Too many failures — circuit breaker open.',
        action: 'Wait a moment, then retry. Run `nimbus doctor` if the issue persists.',
      };

    case ErrorCode.X_INJECTION:
      return {
        summary: 'Potential prompt injection detected.',
        action: 'Review the input and adjust your safety settings.',
      };

    case ErrorCode.X_NETWORK_BLOCKED:
      return {
        summary: 'Network access blocked by safety rules.',
        action: 'Review your network allow-list in workspace settings.',
      };

    case ErrorCode.X_AUDIT_BREAK:
      return {
        summary: 'Audit integrity check failed.',
        action: 'Run `nimbus doctor` — this may indicate a security issue.',
      };

    case ErrorCode.S_COMPACT_FAIL:
      return {
        summary: 'Failed to compact the conversation.',
        action: 'Start a new session. Run with --verbose to see the error.',
      };

    case ErrorCode.S_STORAGE_CORRUPT:
      return {
        summary: 'Session storage appears corrupted.',
        action: 'Run `nimbus doctor` to repair storage.',
      };

    case ErrorCode.S_SOUL_PARSE:
      return {
        summary: 'Failed to parse SOUL.md.',
        action: 'Check SOUL.md for syntax errors.',
      };

    case ErrorCode.S_MEMORY_CONFLICT:
      return {
        summary: 'MEMORY.md has a conflict.',
        action: 'Resolve the conflict in MEMORY.md and restart.',
      };

    case ErrorCode.S_SCHEMA_MISMATCH:
      return {
        summary: 'Stored data schema mismatch — workspace may need migration.',
        action: 'Run `nimbus init --migrate` or contact support.',
      };

    case ErrorCode.P_INVALID_REQUEST:
      return {
        summary: 'The provider rejected the request as invalid.',
        action: 'Check the request parameters. Run with --verbose for details.',
      };

    default:
      return {
        summary: `Error: ${err.code}`,
        action: 'Run with --verbose for details.',
      };
  }
}

/**
 * printError — write 2 lines to stderr + emit debug JSON to logger.
 */
export function printError(err: NimbusError, verbose = false): void {
  const { summary, action } = formatError(err);
  process.stderr.write(`${summary}\n${action}\n`);
  if (verbose) {
    process.stderr.write(`  Debug: ${JSON.stringify(err.toJSON())}\n`);
  }
}
