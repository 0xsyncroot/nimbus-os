// Onboarding.tsx — SPEC-855 T1: 7-step Ink wizard replacing raw readline flow.
// Mounted by runInkInit() via cli.ts `nimbus init` (non-legacy path).
// Step flow: Welcome → Provider → Endpoint (conditional) → Key → Model → Language → Summary
// Draft stash: Ctrl-C writes ~/.nimbus/init-draft.json (mode 0600) for resume.

import React, { useCallback, useEffect, useReducer } from 'react';
import { Box, Text, useInput } from 'ink';
import { Byline } from '../../channels/cli/ink/components/Byline.tsx';
import { WelcomeStep } from './steps/WelcomeStep.tsx';
import { ProviderStep } from './steps/ProviderStep.tsx';
import { EndpointStep } from './steps/EndpointStep.tsx';
import { KeyStep } from './steps/KeyStep.tsx';
import { ModelStep } from './steps/ModelStep.tsx';
import { LanguageStep } from './steps/LanguageStep.tsx';
import { SummaryStep } from './steps/SummaryStep.tsx';
import { logger } from '../../observability/logger.ts';
import { chmod, writeFile } from 'node:fs/promises';
import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

// ── Types ──────────────────────────────────────────────────────────────────────

export interface WizardAnswers {
  provider?: string;
  endpoint?: string;
  baseUrl?: string;
  apiKey?: string;
  modelClass?: 'flagship' | 'workhorse' | 'budget';
  locale?: 'en' | 'vi';
}

export interface InitResult {
  workspaceName: string;
  provider: string;
  locale: 'en' | 'vi';
  modelClass: 'flagship' | 'workhorse' | 'budget';
  endpoint?: string;
  baseUrl?: string;
  apiKeyStored: boolean;
}

export interface OnboardingProps {
  /** Draft stash path for resume support */
  draftPath: string;
  /** Initial answers (from draft stash or pre-filled flags) */
  initialAnswers?: WizardAnswers;
  /** Called when wizard completes successfully */
  onComplete: (result: InitResult) => void;
  /** Called on Ctrl-C abort (after draft saved) */
  onAbort?: () => void;
}

// ── Step ordering ──────────────────────────────────────────────────────────────

type StepId = 'welcome' | 'provider' | 'endpoint' | 'key' | 'model' | 'language' | 'summary';

const ALL_STEPS: StepId[] = ['welcome', 'provider', 'endpoint', 'key', 'model', 'language', 'summary'];
const TOTAL_STEPS = ALL_STEPS.length; // 7

/** Providers that need endpoint selection */
function needsEndpoint(provider: string | undefined): boolean {
  return provider !== undefined && provider !== 'anthropic';
}

/** Providers that need an API key */
function needsKey(provider: string | undefined): boolean {
  return provider !== 'ollama';
}

function nextStep(current: StepId, answers: WizardAnswers): StepId {
  const idx = ALL_STEPS.indexOf(current);
  const candidates = ALL_STEPS.slice(idx + 1);
  for (const step of candidates) {
    if (step === 'endpoint' && !needsEndpoint(answers.provider)) continue;
    if (step === 'key' && !needsKey(answers.provider)) continue;
    return step;
  }
  return 'summary';
}

function prevStep(current: StepId, answers: WizardAnswers): StepId {
  const idx = ALL_STEPS.indexOf(current);
  const candidates = ALL_STEPS.slice(0, idx).reverse();
  for (const step of candidates) {
    if (step === 'endpoint' && !needsEndpoint(answers.provider)) continue;
    if (step === 'key' && !needsKey(answers.provider)) continue;
    return step;
  }
  return 'welcome';
}

function stepNumber(step: StepId, answers: WizardAnswers): number {
  const visible = ALL_STEPS.filter((s) => {
    if (s === 'endpoint' && !needsEndpoint(answers.provider)) return false;
    if (s === 'key' && !needsKey(answers.provider)) return false;
    return true;
  });
  return visible.indexOf(step) + 1;
}

function visibleTotal(answers: WizardAnswers): number {
  return ALL_STEPS.filter((s) => {
    if (s === 'endpoint' && !needsEndpoint(answers.provider)) return false;
    if (s === 'key' && !needsKey(answers.provider)) return false;
    return true;
  }).length;
}

// ── Reducer ────────────────────────────────────────────────────────────────────

interface WizardState {
  step: StepId;
  answers: WizardAnswers;
}

type WizardAction =
  | { type: 'ADVANCE'; patch?: Partial<WizardAnswers> }
  | { type: 'BACK' }
  | { type: 'SET_STEP'; step: StepId };

function reducer(state: WizardState, action: WizardAction): WizardState {
  switch (action.type) {
    case 'ADVANCE': {
      const answers = { ...state.answers, ...action.patch };
      const next = nextStep(state.step, answers);
      return { step: next, answers };
    }
    case 'BACK': {
      const prev = prevStep(state.step, state.answers);
      return { ...state, step: prev };
    }
    case 'SET_STEP':
      return { ...state, step: action.step };
    default:
      return state;
  }
}

// ── Draft stash helpers ────────────────────────────────────────────────────────

async function saveDraft(draftPath: string, state: WizardState): Promise<void> {
  try {
    const content = JSON.stringify({ step: state.step, answers: state.answers }, null, 2);
    await mkdir(dirname(draftPath), { recursive: true });
    await writeFile(draftPath, content, { encoding: 'utf8', flag: 'w' });
    await chmod(draftPath, 0o600).catch(() => undefined);
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'init_draft_save_failed');
  }
}

// ── Component ──────────────────────────────────────────────────────────────────

export function Onboarding({
  draftPath,
  initialAnswers,
  onComplete,
  onAbort,
}: OnboardingProps): React.ReactElement {
  const [state, dispatch] = useReducer(reducer, {
    step: 'welcome',
    answers: initialAnswers ?? {},
  });

  // Ctrl-C → save draft then call onAbort
  useInput(
    useCallback(
      (_input: string, key: { ctrl: boolean; name?: string }) => {
        if (key.ctrl && key.name === 'c') {
          void saveDraft(draftPath, state).then(() => {
            onAbort?.();
          });
        }
      },
      [draftPath, state, onAbort],
    ),
  );

  // When step is 'summary' and user confirms, fire onComplete
  const handleSummarySubmit = useCallback(() => {
    const { answers } = state;
    const result: InitResult = {
      workspaceName: 'personal',
      provider: answers.provider ?? 'anthropic',
      locale: answers.locale ?? 'en',
      modelClass: answers.modelClass ?? 'workhorse',
      ...(answers.endpoint !== undefined ? { endpoint: answers.endpoint } : {}),
      ...(answers.baseUrl !== undefined ? { baseUrl: answers.baseUrl } : {}),
      apiKeyStored: !!(answers.apiKey && answers.apiKey.length > 0),
    };
    onComplete(result);
  }, [state, onComplete]);

  // Summary step Esc
  useEffect(() => {
    // handled per-step via onBack prop
  }, []);

  const stepProps = {
    answers: state.answers,
    onSubmit: (patch?: Partial<WizardAnswers>) => {
      if (state.step === 'summary') {
        handleSummarySubmit();
      } else {
        dispatch({ type: 'ADVANCE', patch });
      }
    },
    onBack: () => dispatch({ type: 'BACK' }),
  };

  const num = stepNumber(state.step, state.answers);
  const total = visibleTotal(state.answers);

  return (
    <Box flexDirection="column" gap={1} paddingX={2} paddingY={1}>
      {/* Progress indicator */}
      <Box flexDirection="row" gap={2}>
        <Text bold color="cyan">nimbus init</Text>
        <Byline>Step {num}/{total}</Byline>
      </Box>

      {/* Active step */}
      {state.step === 'welcome' && <WelcomeStep {...stepProps} />}
      {state.step === 'provider' && <ProviderStep {...stepProps} />}
      {state.step === 'endpoint' && <EndpointStep {...stepProps} />}
      {state.step === 'key' && <KeyStep {...stepProps} />}
      {state.step === 'model' && <ModelStep {...stepProps} />}
      {state.step === 'language' && <LanguageStep {...stepProps} />}
      {state.step === 'summary' && <SummaryStep {...stepProps} />}
    </Box>
  );
}

// Re-export TOTAL_STEPS for tests
export { TOTAL_STEPS };
