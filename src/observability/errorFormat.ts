// errorFormat.ts — SPEC-901 v0.2.1: human-readable error messages for user-facing CLI output.
// Raw JSON context is demoted to logger.debug (visible with --verbose / NIMBUS_LOG_LEVEL=debug).

import { ErrorCode, NimbusError } from './errors.ts';

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

    case ErrorCode.X_CRED_ACCESS:
      return {
        summary: 'Credential access failed.',
        action: 'Your vault may be corrupted or the passphrase changed. Run `nimbus key set` again.',
      };

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

    default:
      return {
        summary: err.message,
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
