// taskSpec.ts — SPEC-110: Runtime SDD generator + FYI display + high-risk gate + persist.

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { ErrorCode, NimbusError } from '../observability/errors.ts';
import { logger } from '../observability/logger.ts';
import type {
  CanonicalMessage,
  Provider,
} from '../ir/types.ts';
import type { EnvironmentSnapshot } from './environment.ts';
import type { PlanDecision } from './planDetector.ts';
import { TASK_SPEC_SYSTEM_PROMPT } from './taskSpecPrompt.ts';
import { sessionPaths } from '../storage/sessionStore.ts';

export const RiskAssessmentSchema = z.object({
  severity: z.enum(['low', 'medium', 'high']),
  reasons: z.array(z.string()).default([]),
});
export type RiskAssessment = z.infer<typeof RiskAssessmentSchema>;

export const TaskSpecSchema = z.object({
  schemaVersion: z.literal(2).default(2),
  turnId: z.string(),
  generatedAt: z.number(),
  outcomes: z.string().min(5).max(400),
  scope: z.object({
    in: z.array(z.string()).min(1),
    out: z.array(z.string()).default([]),
  }),
  actions: z
    .array(z.object({ tool: z.string(), reason: z.string().min(5) }))
    .default([]),
  risks: RiskAssessmentSchema,
  verification: z.string().min(3),
});
export type TaskSpec = z.infer<typeof TaskSpecSchema>;

export interface TaskSpecGenerator {
  generate(userMessage: string, env: EnvironmentSnapshot, turnId: string): Promise<TaskSpec>;
  shouldGenerate(userMessage: string, verdict: PlanDecision): boolean;
}

export interface TaskSpecDeps {
  provider: Provider;
  model: string;
}

function stripJsonFences(raw: string): string {
  const m = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (m && m[1]) return m[1].trim();
  return raw.trim();
}

async function collectText(provider: Provider, messages: CanonicalMessage[], model: string): Promise<string> {
  const ctrl = new AbortController();
  let text = '';
  try {
    for await (const chunk of provider.stream(
      { messages, model, stream: true, maxTokens: 400, temperature: 0.2 },
      { signal: ctrl.signal },
    )) {
      if (chunk.type === 'content_block_start' && chunk.block.type === 'text') {
        text += chunk.block.text;
      } else if (chunk.type === 'content_block_delta' && chunk.delta.type === 'text' && typeof chunk.delta.text === 'string') {
        text += chunk.delta.text;
      } else if (chunk.type === 'message_stop') {
        break;
      } else if (chunk.type === 'error') {
        throw new NimbusError(ErrorCode.P_INVALID_REQUEST, { reason: 'provider_error', message: chunk.message });
      }
    }
  } finally {
    ctrl.abort();
  }
  return text;
}

export function createTaskSpecGenerator(deps: TaskSpecDeps): TaskSpecGenerator {
  async function generate(userMessage: string, env: EnvironmentSnapshot, turnId: string): Promise<TaskSpec> {
    const envXml = `<environment><cwd>${env.cwd}</cwd><now>${env.nowIso}</now></environment>`;
    const msgs: CanonicalMessage[] = [
      { role: 'system', content: [{ type: 'text', text: TASK_SPEC_SYSTEM_PROMPT }] },
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: `User request:\n${userMessage}\n\n${envXml}\n\nRespond with the JSON plan now.`,
          },
        ],
      },
    ];
    const raw = await collectText(deps.provider, msgs, deps.model);
    const jsonStr = stripJsonFences(raw);
    let parsed: unknown;
    try {
      parsed = JSON.parse(jsonStr);
    } catch (err) {
      throw new NimbusError(ErrorCode.P_INVALID_REQUEST, {
        reason: 'task_spec_json_parse',
        raw: jsonStr.slice(0, 200),
        err: (err as Error).message,
      });
    }
    const withMeta = {
      ...(parsed as object),
      turnId,
      generatedAt: Date.now(),
      schemaVersion: 2,
    };
    const res = TaskSpecSchema.safeParse(withMeta);
    if (!res.success) {
      throw new NimbusError(ErrorCode.P_INVALID_REQUEST, {
        reason: 'task_spec_schema',
        issues: res.error.issues.map((i) => i.message),
      });
    }
    return res.data;
  }

  function shouldGenerate(userMessage: string, verdict: PlanDecision): boolean {
    if (userMessage.trim().length < 6) return false;
    if (verdict.plan) return true;
    // Trivial-heuristic skip: no plan trigger AND short input → skip.
    if (userMessage.length < 60) return false;
    return true;
  }

  return { generate, shouldGenerate };
}

export function displaySpecInline(spec: TaskSpec): string {
  const actions = spec.actions
    .slice(0, 3)
    .map((a) => `• ${a.tool} — ${a.reason}`)
    .join('\n');
  const extraActions = spec.actions.length > 3 ? ` (+${spec.actions.length - 3} more)` : '';
  const riskTag = spec.risks.severity === 'high' ? '[HIGH RISK]'
    : spec.risks.severity === 'medium' ? '[medium risk]' : '';
  const lines = [
    `Plan${riskTag ? ' ' + riskTag : ''}: ${spec.outcomes}`,
    actions.length > 0 ? `${actions}${extraActions}` : null,
    `Verify: ${spec.verification}`,
  ].filter((l): l is string => l !== null);
  return lines.join('\n');
}

export interface HighRiskConfirmer {
  confirm(spec: TaskSpec): Promise<boolean>;
}

export async function highRiskGate(
  spec: TaskSpec,
  confirmer: HighRiskConfirmer,
  forceAlways = false,
): Promise<boolean> {
  if (!forceAlways && spec.risks.severity !== 'high') return true;
  try {
    return await confirmer.confirm(spec);
  } catch (err) {
    logger.warn({ err: (err as Error).message, turnId: spec.turnId }, 'high-risk confirmer failed; blocking by default');
    return false;
  }
}

export function persistSpecAsync(spec: TaskSpec, wsId: string, sessionId: string): void {
  void (async () => {
    try {
      const paths = sessionPaths(wsId, sessionId);
      await mkdir(paths.taskSpecs, { recursive: true });
      const dest = join(paths.taskSpecs, `${spec.turnId}.spec.md`);
      const front = [
        '---',
        'schemaVersion: 2',
        `turnId: ${spec.turnId}`,
        `generatedAt: ${spec.generatedAt}`,
        `severity: ${spec.risks.severity}`,
        '---',
        '',
      ].join('\n');
      const body = [
        `# Task Spec ${spec.turnId}`,
        '',
        '## Outcomes',
        spec.outcomes,
        '',
        '## Scope',
        `- In: ${spec.scope.in.join('; ')}`,
        spec.scope.out.length > 0 ? `- Out: ${spec.scope.out.join('; ')}` : null,
        '',
        '## Actions',
        ...spec.actions.map((a) => `- ${a.tool}: ${a.reason}`),
        '',
        '## Risks',
        `- severity: ${spec.risks.severity}`,
        ...spec.risks.reasons.map((r) => `- ${r}`),
        '',
        '## Verification',
        spec.verification,
        '',
      ]
        .filter((l): l is string => l !== null)
        .join('\n');
      await writeFile(dest, front + body, { encoding: 'utf8' });
    } catch (err) {
      logger.warn({ err: (err as Error).message, turnId: spec.turnId }, 'persist task spec failed');
    }
  })();
}
