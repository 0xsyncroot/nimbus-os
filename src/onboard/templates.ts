// templates.ts — SPEC-901 T2/T3: template strings + ${var} substitution.

import { ErrorCode, NimbusError } from '../observability/errors.ts';
import type { InitAnswers } from './questions.ts';

const SOUL_TEMPLATE = `---
schemaVersion: 1
name: \${workspaceName}
created: \${today}
---

# Identity

I am nimbus, a personal AI agent serving \${workspaceName}.
Primary purpose: \${primaryUseCase}

# Values

- Show preview before destructive or irreversible actions
- State uncertainty explicitly, never fabricate
- Confirm before sending to external services
- Respect user's time: be concise, be useful

# Communication Style

- Voice: \${voice}
- Language: \${language}

# Boundaries

- Will NOT auto-delete without explicit confirmation
- Will only modify SOUL.md when user explicitly edits
- Will NOT expose secrets (API keys, tokens, credentials) in output
`;

const IDENTITY_TEMPLATE = `---
schemaVersion: 1
created: \${today}
---

# IDENTITY

Role, background, and context about the human you're serving.

See SOUL.md for agent personality. This file captures facts about the user.
`;

const MEMORY_TEMPLATE = `---
schemaVersion: 1
updated: \${today}
---

# MEMORY

## Projects

_(auto-populated as we work together)_

## Preferences

- Language: \${language}
- Voice: \${voice}

## Facts

_(stable user facts added over time)_
`;

const TOOLS_TEMPLATE = `---
schemaVersion: 1
---

# TOOLS

## Active tools

Default v0.1 toolset (read/write files, shell, web fetch).

## Bash rules

Preset: **\${bashPreset}**

\${bashRules}
`;

const DREAMS_TEMPLATE = `---
schemaVersion: 1
---

# Dream consolidations

_(populated by SPEC-112 v0.2 + SPEC-114 v0.3 + Dreaming v0.5)_
`;

const CLAUDE_TEMPLATE = `# \${workspaceName} — AI Agent Notes

Primary use case: \${primaryUseCase}
Provider: \${provider} (\${modelClass})
Language: \${language}

See SOUL.md for personality, IDENTITY.md for user context, MEMORY.md for persistent memory.
`;

const BASH_RULES: Record<string, string> = {
  strict: `- Never run destructive commands (rm -rf, dd, mkfs)
- Never modify system files (/etc, /usr, /bin)
- Always preview with --dry-run when available
- Confirm every bash action`,
  balanced: `- Preview destructive commands before executing
- Respect user's working directory
- Avoid background processes unless requested`,
  permissive: `- Execute user-requested commands directly
- Still refuses: fork bombs, credential theft, network attacks`,
};

export interface RenderContext extends InitAnswers {
  today: string;
  bashRules: string;
}

function substitute(template: string, vars: Record<string, string>): string {
  return template.replace(/\$\{(\w+)\}/g, (_m, name: string) => {
    if (!(name in vars)) {
      throw new NimbusError(ErrorCode.U_MISSING_CONFIG, { reason: 'template_missing_var', name });
    }
    return vars[name]!;
  });
}

export function buildRenderContext(answers: InitAnswers, today: string): RenderContext {
  return {
    ...answers,
    today,
    bashRules: BASH_RULES[answers.bashPreset] ?? BASH_RULES['balanced']!,
  };
}

export function renderTemplates(answers: InitAnswers, today: string): Record<string, string> {
  const ctx = buildRenderContext(answers, today);
  const vars: Record<string, string> = {};
  for (const [k, v] of Object.entries(ctx)) {
    vars[k] = typeof v === 'string' ? v : String(v);
  }
  return {
    'SOUL.md': substitute(SOUL_TEMPLATE, vars),
    'IDENTITY.md': substitute(IDENTITY_TEMPLATE, vars),
    'MEMORY.md': substitute(MEMORY_TEMPLATE, vars),
    'TOOLS.md': substitute(TOOLS_TEMPLATE, vars),
    'DREAMS.md': substitute(DREAMS_TEMPLATE, vars),
    'CLAUDE.md': substitute(CLAUDE_TEMPLATE, vars),
  };
}

/**
 * Minimal SOUL.md written during `quickInit` (auto-first-run, no wizard prompts).
 * Uses ${today} as the only substitution variable.
 */
export const DEFAULT_SOUL_MD = (today: string): string =>
  `---
schemaVersion: 1
name: personal
created: ${today}
---

# Identity
I am nimbus, your personal AI assistant.

# Values
- Be concise and useful
- Preview before destructive actions
- State uncertainty, never fabricate
- Respect privacy — never expose secrets

# Communication Style
- Friendly, casual tone
- Match the language the user writes in

# Boundaries
- Confirm before deleting files or sending external requests
`;

export const __testing = { substitute, SOUL_TEMPLATE, BASH_RULES };
