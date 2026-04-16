// questions.ts — SPEC-901 T1: interactive question set with validators.

import { z } from 'zod';
import { createInterface } from 'node:readline';
import { ErrorCode, NimbusError } from '../observability/errors.ts';

export const EndpointEnum = z.enum(['openai', 'groq', 'deepseek', 'ollama', 'gemini', 'custom']);
export type Endpoint = z.infer<typeof EndpointEnum>;

export const InitAnswersSchema = z.object({
  workspaceName: z.string().regex(/^[a-z][a-z0-9-]{2,31}$/, {
    message: 'must match ^[a-z][a-z0-9-]{2,31}$',
  }),
  primaryUseCase: z.string().min(3).max(200),
  voice: z.enum(['formal', 'casual', 'laconic', 'verbose']),
  language: z.enum(['en', 'vi']).default('en'),
  provider: z.enum(['anthropic', 'openai', 'groq', 'deepseek', 'ollama', 'gemini']),
  modelClass: z.enum(['flagship', 'workhorse', 'budget']),
  bashPreset: z.enum(['strict', 'balanced', 'permissive']).default('balanced'),
  endpoint: EndpointEnum.optional(),
  baseUrl: z.string().url().optional(),
  location: z.string().optional(),
}).superRefine((val, ctx) => {
  if (val.endpoint === 'custom' && !val.baseUrl) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['baseUrl'],
      message: 'baseUrl is required when endpoint="custom"',
    });
  }
});
export type InitAnswers = z.infer<typeof InitAnswersSchema>;

const DEV_USECASE_RE = /\b(cod(?:e|ing)|dev(?:eloper|elopment)?|software|programm(?:er|ing))\b/i;

export function shouldAskBashPreset(primaryUseCase: string): boolean {
  return DEV_USECASE_RE.test(primaryUseCase);
}

export interface AskIO {
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
}

async function ask(prompt: string, io: AskIO): Promise<string> {
  const input = io.input ?? process.stdin;
  const output = io.output ?? process.stdout;
  const rl = createInterface({ input, output, terminal: false });
  return new Promise((resolve, reject) => {
    rl.question(prompt, (answer: string) => {
      rl.close();
      resolve(answer);
    });
    rl.once('SIGINT', () => {
      rl.close();
      reject(new NimbusError(ErrorCode.U_BAD_COMMAND, { reason: 'cancelled' }));
    });
  });
}

async function askWithDefault<T extends string>(
  prompt: string,
  def: T,
  validate: (v: string) => T | null,
  io: AskIO,
): Promise<T> {
  for (let i = 0; i < 3; i++) {
    const raw = (await ask(`${prompt} [${def}]: `, io)).trim();
    const v = raw === '' ? def : validate(raw);
    if (v !== null) return v;
    io.output?.write(`invalid — try again\n`);
  }
  throw new NimbusError(ErrorCode.U_BAD_COMMAND, { reason: 'too_many_invalid_answers' });
}

function oneOf<T extends string>(choices: readonly T[]): (v: string) => T | null {
  return (v: string) => (choices.includes(v as T) ? (v as T) : null);
}

export async function askAll(io: AskIO = {}): Promise<InitAnswers> {
  const workspaceName = await askWithDefault(
    'Workspace name',
    'personal',
    (v) => (/^[a-z][a-z0-9-]{2,31}$/.test(v) ? v : null),
    io,
  );
  const primaryUseCase = await askWithDefault(
    'Primary use case (e.g., daily assistant, research, coding)',
    'daily assistant',
    (v) => (v.length >= 3 && v.length <= 200 ? v : null),
    io,
  );
  const voice = await askWithDefault('Voice (formal/casual/laconic/verbose)', 'casual',
    oneOf(['formal', 'casual', 'laconic', 'verbose'] as const), io);
  const language = await askWithDefault('Language (en/vi)', 'en', oneOf(['en', 'vi'] as const), io);
  const provider = await askWithDefault('Provider (anthropic/openai/groq/deepseek/ollama)', 'anthropic',
    oneOf(['anthropic', 'openai', 'groq', 'deepseek', 'ollama'] as const), io);
  const modelClass = await askWithDefault('Model class (flagship/workhorse/budget)', 'workhorse',
    oneOf(['flagship', 'workhorse', 'budget'] as const), io);

  let bashPreset: 'strict' | 'balanced' | 'permissive' = 'balanced';
  if (shouldAskBashPreset(primaryUseCase)) {
    bashPreset = await askWithDefault('Bash preset (strict/balanced/permissive)', 'balanced',
      oneOf(['strict', 'balanced', 'permissive'] as const), io);
  }

  let endpoint: Endpoint | undefined;
  let baseUrl: string | undefined;
  if (provider !== 'anthropic') {
    // openai-compat needs an endpoint target + optional custom URL.
    const inferred = (provider === 'openai' || provider === 'groq' || provider === 'deepseek' || provider === 'ollama' || provider === 'gemini')
      ? provider : 'openai';
    endpoint = await askWithDefault(
      'Endpoint (openai/groq/deepseek/ollama/gemini/custom)',
      inferred,
      oneOf(['openai', 'groq', 'deepseek', 'ollama', 'gemini', 'custom'] as const),
      io,
    );
    if (endpoint === 'custom') {
      baseUrl = await askWithDefault(
        'Base URL (e.g., http://localhost:9000/v1)',
        'http://localhost:8080/v1',
        (v) => (isLikelyUrl(v) ? v : null),
        io,
      );
    }
  }

  return InitAnswersSchema.parse({
    workspaceName,
    primaryUseCase,
    voice,
    language,
    provider,
    modelClass,
    bashPreset,
    ...(endpoint !== undefined ? { endpoint } : {}),
    ...(baseUrl !== undefined ? { baseUrl } : {}),
  });
}

export function isLikelyUrl(s: string): boolean {
  try {
    const u = new URL(s);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

export const __testing = { DEV_USECASE_RE, isLikelyUrl };
